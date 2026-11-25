import { OsEventTypeList as Gesture, type EvenAppBridge, type EvenHubEvent } from '@evenrealities/even_hub_sdk'
import { MAX_RECORDING_SECONDS } from '../config'
import { startRecording, type Recorder } from './audio'
import type { LensMessage } from './messages'
import { startupPage, lensPage, paginate, type LensPage } from './screens'

export interface LensView {
  thread: string | null
  messages: readonly LensMessage[]
  status: string
  canRecord: boolean
  pending: boolean
}

type Stage = 'read' | 'starting' | 'recording' | 'stopping' | 'review' | 'sending'
type Voice = (target: string, audio: Blob) => Promise<'sent' | 'pending'>

export class LensController {
  private view: LensView = { thread: null, messages: [], status: 'Open Okou on your phone', canRecord: false, pending: false }
  private stage: Stage = 'read'
  private note = ''
  private recorder: Recorder | null = null
  private clip: Blob | null = null
  private revision = 0
  private timer?: ReturnType<typeof setTimeout>
  private unsubscribe?: () => void
  private selection: { id: string; page: number } | null = null
  private renderQueue = Promise.resolve()
  private lastPage = ''
  private closed = false
  private micCleanup: Promise<void> = Promise.resolve()

  constructor(private readonly bridge: EvenAppBridge, private readonly send: Voice,
    private readonly refresh: () => void, private readonly onError: (message: string) => void) {}

  async start() {
    if (await this.bridge.createStartUpPageContainer(startupPage()) !== 0) throw new Error('Could not open the G2 display')
    if (this.closed) return
    this.unsubscribe = this.bridge.onEvenHubEvent((event) => this.handle(event))
    this.draw()
  }

  update(view: LensView) {
    const changed = view.thread !== this.view.thread
    if (view.messages.at(-1)?.id !== this.view.messages.at(-1)?.id && this.stage === 'read') this.note = ''
    this.view = view
    if (changed) {
      this.selection = null
      this.cancel()
    } else this.draw()
  }

  suspend() {
    if (this.stage !== 'sending') this.cancel()
  }

  close() {
    this.closed = true
    this.unsubscribe?.()
    this.cancel()
  }

  private cancel() {
    this.revision++
    clearTimeout(this.timer)
    if (this.recorder) {
      this.micCleanup = this.recorder.cancel().catch(() => this.onError('Could not close the microphone'))
    }
    this.recorder = null
    this.clip = null
    this.stage = 'read'
    this.note = ''
    this.draw()
  }

  private handle(event: EvenHubEvent) {
    const gesture = event.textEvent ?? event.sysEvent ?? event.listEvent
    if (this.closed || !gesture) return // PCM frames are not taps.
    const type = gesture.eventType ?? Gesture.CLICK_EVENT
    if (type === Gesture.FOREGROUND_ENTER_EVENT) { this.lastPage = ''; this.refresh(); this.draw(); return }
    if ([Gesture.FOREGROUND_EXIT_EVENT, Gesture.SYSTEM_EXIT_EVENT, Gesture.ABNORMAL_EXIT_EVENT].includes(type)) {
      this.suspend()
      return
    }
    if (type === Gesture.DOUBLE_CLICK_EVENT) {
      if (this.stage === 'read') void this.bridge.shutDownPageContainer(1).catch(() => this.onError('Could not close the G2 page'))
      else if (this.stage !== 'sending') this.cancel()
      return
    }
    if (this.stage === 'read' && (type === Gesture.SCROLL_TOP_EVENT || type === Gesture.SCROLL_BOTTOM_EVENT)) {
      this.scroll(type === Gesture.SCROLL_TOP_EVENT ? -1 : 1)
    } else if (type === Gesture.CLICK_EVENT) void this.tap()
  }

  private activeMessage() {
    const list = this.view.messages
    const chosen = this.selection && list.findIndex((m) => m.id === this.selection!.id)
    const index = chosen !== null && chosen >= 0 ? chosen : list.length - 1
    const message = list[index]
    if (!message) return null
    const pages = paginate(message.text)
    const page = Math.min(this.selection?.id === message.id ? this.selection.page : 0, pages.length - 1)
    return { message, index, pages, page }
  }

  private scroll(direction: number) {
    const at = this.activeMessage()
    if (!at) return
    let id = at.message.id, page = at.page + direction
    if (page < 0 || page >= at.pages.length) {
      const adjacent = this.view.messages[at.index + direction]
      if (!adjacent) return
      id = adjacent.id
      page = direction > 0 ? 0 : paginate(adjacent.text).length - 1
    }
    this.selection = id === this.view.messages.at(-1)?.id && page === 0 ? null : { id, page }
    this.note = ''
    this.draw()
  }

  private async tap() {
    if (this.stage === 'recording') return this.finishRecording(true)
    if (this.stage === 'review') return this.sendClip()
    if (this.stage !== 'read') return
    if (!this.view.canRecord || !this.view.thread || this.view.pending) { this.refresh(); return }
    this.stage = 'starting'
    this.note = ''
    this.draw()
    const version = ++this.revision
    // If the account changes while audioControl(true) is in flight, turn off
    // that microphone before a new capture is allowed to open it again.
    this.micCleanup = this.micCleanup.then(async () => {
      if (version !== this.revision) return
      const recorder = await startRecording(this.bridge)
      if (version !== this.revision) { await recorder.cancel(); return }
      this.recorder = recorder
      this.stage = 'recording'
      this.timer = setTimeout(() => void this.finishRecording(false), MAX_RECORDING_SECONDS * 1000)
    }).catch(() => {
      if (version === this.revision) { this.stage = 'read'; this.note = 'Microphone unavailable · tap to retry' }
    })
    await this.micCleanup
    this.draw()
  }

  private async finishRecording(send: boolean) {
    const recorder = this.recorder
    if (!recorder || this.stage !== 'recording') return
    const version = this.revision
    this.recorder = null
    clearTimeout(this.timer)
    this.stage = 'stopping'
    this.draw()
    try {
      const stopped = recorder.stop()
      this.micCleanup = stopped.then(() => undefined, () => undefined)
      const audio = await stopped
      if (version !== this.revision) return
      if (!audio) { this.note = 'No audio captured · tap to retry'; this.stage = 'read' }
      else {
        this.clip = audio
        this.stage = 'review'
        if (send) return this.sendClip()
      }
    } catch {
      if (version === this.revision) { this.note = 'Recording failed · tap to retry'; this.stage = 'read' }
    }
    this.draw()
  }

  private async sendClip() {
    if (!this.clip || !this.view.thread || this.stage !== 'review') return
    const version = this.revision
    this.stage = 'sending'
    this.draw()
    try {
      const result = await this.send(this.view.thread, this.clip)
      if (version !== this.revision) return
      this.clip = null
      this.stage = 'read'
      this.selection = null
      this.note = result === 'sent' ? 'Voice message sent' : ''
    } catch (error) {
      if (version !== this.revision) return
      this.onError(error instanceof Error ? error.message : 'Send failed')
      this.note = 'Send failed'
      this.stage = 'review'
    }
    this.draw()
  }

  private page(): LensPage {
    if (this.stage !== 'read') {
      const body = { starting: 'Opening microphone…', recording: 'Listening…', stopping: 'Finishing recording…',
        review: this.note || 'Recording ready', sending: 'Sending voice message…' }[this.stage]
      return { heading: 'Voice message', body, footer: this.stage === 'recording' || this.stage === 'review'
        ? 'Tap to send · double-tap to discard' : '' }
    }
    const at = this.activeMessage()
    const status = this.view.pending ? 'Checking delivery · tap to refresh' : this.view.status
    return {
      heading: at ? (at.message.role === 'assistant' ? 'Okou' : 'You') + '   ' + (at.page + 1) + '/' + at.pages.length : 'Okou',
      body: at?.pages[at.page] ?? (this.view.thread && !status ? 'No messages yet' : status),
      footer: !at && status ? '' : status || this.note || 'Swipe to read · tap to speak',
    }
  }

  private draw() {
    if (this.closed || !this.unsubscribe) return
    this.renderQueue = this.renderQueue.then(async () => {
      if (this.closed) return
      const page = this.page(), key = JSON.stringify(page)
      if (this.lastPage === key) return
      if (!await this.bridge.rebuildPageContainer(lensPage(page))) throw new Error('Could not update the G2 display')
      this.lastPage = key
    }).catch((e: Error) => this.onError(e.message))
  }
}
