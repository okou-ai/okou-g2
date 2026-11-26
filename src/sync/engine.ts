import { ApiError, OkouApiClient, type TokenProvider } from '../api/client'
import { requireCancellationGrant } from '../device-protocol'
import { DeviceStore, type Pending } from '../store'
import type { ChatEventRow, Identity } from '../types'
import type { RecordedVoice } from '../lens/recording'
import { currentTask, type TaskTarget } from '../lens/messages'
import { readHistory, type History } from './messages'

export interface ChatState {
  thread: string | null
  rows: readonly ChatEventRow[]
  live: boolean
  syncing: boolean
  pending: boolean
  error: string | null
}

export const initialChat: ChatState = {
  thread: null, rows: [], live: false, syncing: false, pending: false, error: null,
}

export class DeviceChat {
  private state = initialChat
  private readonly abort = new AbortController()
  private readonly api: OkouApiClient
  private readonly store: DeviceStore
  private history: History | null = null
  private unwatch?: () => void
  private fallback?: ReturnType<typeof setInterval>
  private refreshing: Promise<void> | null = null
  private dirty = false
  private sending = false
  private readonly uploaded = new WeakMap<RecordedVoice, string[]>()

  constructor(private readonly identity: Identity, getToken: TokenProvider,
      private readonly onChange: (state: ChatState) => void) {
    this.api = new OkouApiClient(getToken, this.abort.signal)
    this.store = new DeviceStore(identity)
  }

  private publish(patch: Partial<ChatState>) {
    if (this.abort.signal.aborted) return
    this.state = { ...this.state, ...patch }
    this.onChange(this.state)
  }

  start() {
    this.fallback = setInterval(() => {
      if (!this.state.live && document.visibilityState === 'visible') void this.refresh()
    }, 30_000)
    return this.refresh()
  }

  private async bind(missingThread?: string) {
    const id = await this.store.fixedThread(this.api, missingThread)
    this.abort.signal.throwIfAborted()
    if (id === this.state.thread) return
    this.unwatch?.()
    this.history = null
    const pending = !!await this.store.pending(id)
    this.abort.signal.throwIfAborted()
    this.publish({ thread: id, rows: [], pending, live: false })
    // Opening the reader does not depend on loading or connecting Ably.
    void import('./realtime').then(({ watchThread }) => {
      if (this.abort.signal.aborted || this.state.thread !== id) return
      this.unwatch = watchThread(this.api, this.identity, id, () => void this.refresh(), (live) => this.publish({ live }))
    }).catch(() => { if (this.state.thread === id) this.publish({ live: false }) })
  }

  // Coalesce bursts, then run one more tail read if a notification arrived
  // while a page was in flight. A background refresh never resubmits input.
  refresh(): Promise<void> {
    if (this.abort.signal.aborted) return Promise.resolve()
    this.dirty = true
    this.refreshing ??= this.drain().finally(() => {
      this.refreshing = null
      if (this.dirty && !this.abort.signal.aborted) void this.refresh()
    })
    return this.refreshing
  }

  private async drain() {
    this.publish({ syncing: true })
    let replacedMissingThread = false
    try {
      while (this.dirty && !this.abort.signal.aborted) {
        this.dirty = false
        if (!this.state.thread) await this.bind()
        const id = this.state.thread!
        const pending = await this.store.pending(id)
        let history
        try {
          history = await readHistory(this.api, id, this.history, pending?.clientEventId)
        } catch (error) {
          // get_chat_messages checks thread ownership before returning history. A missing
          // transport endpoint or expired cursor must never allocate another conversation.
          if (!replacedMissingThread && error instanceof ApiError && error.missingThread) {
            replacedMissingThread = true
            await this.bind(id)
            if (this.state.thread !== id) { this.dirty = true; continue }
          }
          throw error
        }
        this.abort.signal.throwIfAborted()
        if (history.acknowledged && pending) await this.store.acknowledge(id, pending.clientEventId)
        this.history = history
        this.publish({ rows: history.rows, pending: !!await this.store.pending(id), error: null })
      }
    } catch (error) {
      this.publish({ error: error instanceof Error ? error.message : 'Could not read the conversation' })
    } finally { this.publish({ syncing: false }) }
  }

  private assertTarget(thread: string) {
    this.abort.signal.throwIfAborted()
    if (this.state.thread !== thread) throw new Error('The conversation changed. Record again.')
  }

  private async submit(thread: string, pending: Pending, token: string, firstAttempt: boolean): Promise<'sent' | 'pending'> {
    const { fileIds, clientEventId } = pending
    this.publish({ pending: true })
    try {
      const reply = await this.api.call<{ threadId: string; eventId: string }>('send_chat_message', {
        threadId: thread, clientEventId,
        userMessage: { version: 1, parts: fileIds.map(fileId => ({ type: 'voice', clips: [{ fileId }] })) },
      }, token)
      if (reply.threadId !== thread || reply.eventId !== clientEventId) return 'pending'
    } catch (error) {
      if (!(error instanceof ApiError && error.rejected)) return 'pending'
      if (firstAttempt) {
        await this.store.acknowledge(thread, clientEventId)
        this.publish({ pending: false })
      }
      throw error
    }
    await this.store.acknowledge(thread, clientEventId)
    this.publish({ pending: false })
    return 'sent'
  }

  async cancelTask(thread: string, target: TaskTarget) {
    const token = await this.api.getToken()
    this.assertTarget(thread)
    const active = currentTask(this.state.rows)
    if (active?.id !== target.id || active.kind !== target.kind) return
    requireCancellationGrant(token)
    try {
      if (target.kind === 'run') await this.api.call('cancel_run', { runId: target.id }, token)
      else await this.api.call('revoke_queued_message', { threadId: thread, eventId: target.id }, token)
    } finally {
      void this.refresh()
    }
  }

  async sendVoice(thread: string, audio: RecordedVoice): Promise<'sent' | 'pending'> {
    this.assertTarget(thread)
    if (this.sending) throw new Error('Another recording is being sent')
    this.sending = true
    try {
      if (await this.store.pending(thread)) throw new Error('The previous send is awaiting confirmation')
      const fileCount = audio.fileCount
      if (!fileCount) throw new Error('No audio captured')
      const fileIds = this.uploaded.get(audio) ?? []
      this.uploaded.set(audio, fileIds)
      // Keep each completed upload across an explicit retry. The ordered parts
      // form one chat input even when a recording exceeds one transcription batch.
      while (fileIds.length < fileCount) {
        const wav = await audio.file(fileIds.length)
        this.assertTarget(thread)
        fileIds.push(await this.api.upload(wav))
      }
      const token = await this.api.getToken()
      this.assertTarget(thread)
      const pending = await this.store.reserveSend(thread, fileIds)
      try { this.assertTarget(thread) } catch (error) {
        await this.store.acknowledge(thread, pending.clientEventId)
        throw error
      }
      return await this.submit(thread, pending, token, true)
    } finally {
      this.sending = false
      void this.refresh()
    }
  }

  // The API recognizes a repeat of the same clientEventId for this user and
  // thread. Only an explicit retry replays the exact saved clip and IDs.
  async retryPending() {
    const thread = this.state.thread
    if (!thread || this.sending) return
    this.sending = true
    try {
      const pending = await this.store.pending(thread)
      if (!pending) return
      const token = await this.api.getToken()
      this.assertTarget(thread)
      await this.submit(thread, pending, token, false)
    } finally {
      this.sending = false
      void this.refresh()
    }
  }

  close() {
    this.abort.abort()
    clearInterval(this.fallback)
    this.unwatch?.()
  }
}
