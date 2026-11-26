import { OsEventTypeList as Gesture, type EvenAppBridge, type EvenHubEvent } from '@evenrealities/even_hub_sdk'
import type { RecordedVoice } from './recording'
import { startRecording, type Recorder } from './audio'
import type { LensMessage, TaskTarget } from './messages'
import { indicatorUpdate, listeningLabel, statusUpdate, startupPage, lensPage, menuItems, paginate, type LensPage, type Menu } from './screens'

export interface LensView {
  thread: string | null
  messages: readonly LensMessage[]
  task: TaskTarget | null
  status: string
  canRecord: boolean
  pending: boolean
}

type Stage = 'quiet' | 'reader' | 'starting' | 'recording' | 'stopping' | 'review' | 'sending'
type Voice = (target: string, audio: RecordedVoice) => Promise<'sent' | 'pending'>

const readKey = (thread: string) => 'okou.g2.last-read.' + thread

export class LensController {
  private view: LensView = { thread: null, messages: [], task: null, status: '', canRecord: false, pending: false }
  private stage: Stage = 'quiet'
  private menu: { kind: Menu; task?: TaskTarget | null } | null = null
  private readSeq = 0
  private pages: string[] = ['']
  private pageIndex = 0
  private sentAfter: number | null = null
  private note = ''
  private recorder: Recorder | null = null
  private clip: RecordedVoice | null = null
  private revision = 0
  private unsubscribe?: () => void
  private renderQueue = Promise.resolve()
  private lastPage = ''
  private lastDotLevel = 0
  private dim = false
  private readonly heartbeat = (event: AnimationEvent) => {
    if (event.animationName !== 'lens-working' || event.target !== document.documentElement) return
    this.dim = !this.dim
    this.draw()
  }
  private lastStatus = ''
  private active = true
  private closed = false
  private micCleanup: Promise<void> = Promise.resolve()

  constructor(private readonly bridge: EvenAppBridge, private readonly send: Voice,
    private readonly refresh: () => void, private readonly onError: (message: string) => void,
    private readonly cancelTask: (thread: string, task: TaskTarget) => Promise<void>) {}

  async start() {
    if (await this.bridge.createStartUpPageContainer(startupPage()) !== 0) throw new Error('Could not open the G2 display')
    if (this.closed) return
    if (typeof document !== 'undefined') document.documentElement?.addEventListener('animationiteration', this.heartbeat)
    this.unsubscribe = this.bridge.onEvenHubEvent((event) => this.handle(event))
    this.draw()
  }

  update(view: LensView) {
    const changedThread = view.thread !== this.view.thread
    const previous = this.view.messages.at(-1)
    const latest = view.messages.at(-1)
    this.view = view
    if (changedThread) {
      this.readSeq = 0
      try { if (view.thread) this.readSeq = Number(localStorage.getItem(readKey(view.thread))) || 0 }
      catch { /* Use the in-memory cursor when browser storage is unavailable. */ }
      this.sentAfter = null
      this.reset('quiet')
    }
    if (changedThread || latest?.id !== previous?.id || latest?.text !== previous?.text) {
      this.pageIndex = 0
      this.pages = latest?.role === 'assistant' ? paginate(latest.text) : ['']
      if (this.stage === 'reader') this.note = ''
      if (latest && this.sentAfter !== null && latest.seqId > this.sentAfter) this.sentAfter = null
    }
    this.draw()
  }

  suspend() {
    // The phone can lock while the glasses are still in use. Actual lens exit,
    // sign-out and workspace changes still close the microphone.
    if (this.stage === 'reader') this.reset('quiet')
  }

  close() {
    this.closed = true
    if (typeof document !== 'undefined') document.documentElement?.removeEventListener('animationiteration', this.heartbeat)
    this.animateWork(false)
    this.unsubscribe?.()
    this.reset('quiet')
  }

  private discard(clip: RecordedVoice | null) {
    if (clip) void clip.discard().catch(() => this.onError('Could not clear the recording from local storage'))
  }

  private reset(next: 'quiet' | 'reader') {
    this.revision++
    if (this.recorder) {
      this.micCleanup = this.recorder.cancel().catch(() => this.onError('Could not close the microphone'))
    }
    this.recorder = null
    this.discard(this.clip)
    this.clip = null
    this.menu = null
    this.stage = next
    this.note = ''
    this.pageIndex = 0
    this.draw()
  }

  private showReader(note = '') {
    this.stage = 'reader'
    this.menu = null
    this.note = note
    this.draw()
  }

  private leaveDisplay() {
    this.active = false
    this.animateWork(false)
    this.reset('quiet')
  }

  private async exitToLauncher(exitMode: 0 | 1) {
    if (exitMode === 0) this.leaveDisplay()
    try {
      if (await this.bridge.shutDownPageContainer(exitMode)) return
    } catch { /* Restore the reader if the immediate exit did not complete. */ }
    if (exitMode === 0 && !this.closed) {
      this.active = true
      this.lastPage = ''
      this.showReader()
    }
    this.onError('Could not close the G2 page')
  }

  private handle(event: EvenHubEvent) {
    const gesture = event.sysEvent ?? event.listEvent ?? event.textEvent
    if (this.closed || !gesture) return
    const type = gesture.eventType ?? Gesture.CLICK_EVENT
    if (type === Gesture.SYSTEM_EXIT_EVENT || type === Gesture.ABNORMAL_EXIT_EVENT) {
      this.leaveDisplay()
      return
    }
    if (type === Gesture.FOREGROUND_ENTER_EVENT) { this.active = true; this.lastPage = ''; this.refresh(); this.draw(); return }
    if (!this.active) return
    // The OS also emits FOREGROUND_EXIT when its contextual overlay closes.
    if (type === Gesture.FOREGROUND_EXIT_EVENT || type === Gesture.LONG_PRESS_RELEASE_EVENT) return
    if (![Gesture.CLICK_EVENT, Gesture.DOUBLE_CLICK_EVENT, Gesture.LONG_PRESS_EVENT,
      Gesture.SCROLL_TOP_EVENT, Gesture.SCROLL_BOTTOM_EVENT].includes(type)) return
    if (this.menu) {
      if (type === Gesture.DOUBLE_CLICK_EVENT) { this.menu = null; this.draw() }
      else if (type === Gesture.CLICK_EVENT && event.listEvent) this.selectAction(event.listEvent)
      return
    }
    if (event.listEvent) return
    if (type === Gesture.LONG_PRESS_EVENT) {
      if (this.stage === 'reader') this.menu = { kind: 'reader', task: this.view.task }
      if (this.stage === 'recording' || this.stage === 'review') this.menu = { kind: 'voice' }
      this.draw()
    } else if (type === Gesture.DOUBLE_CLICK_EVENT) {
      if (this.stage === 'quiet') void this.exitToLauncher(1)
      else if (this.stage === 'reader') this.reset('quiet')
      else if (this.stage === 'sending') void this.exitToLauncher(1)
      else this.reset('reader')
    } else if (type === Gesture.CLICK_EVENT) {
      void this.tap()
    } else if (this.stage === 'reader') {
      const step = type === Gesture.SCROLL_TOP_EVENT ? -1 : 1
      this.pageIndex = Math.max(0, Math.min(this.pages.length - 1, this.pageIndex + step))
      this.draw()
    }
  }

  private selectAction(event: NonNullable<EvenHubEvent['listEvent']>) {
    const menu = this.menu
    if (!menu || (event.containerID !== undefined && event.containerID !== 5)) return
    const items = menuItems(menu.kind)
    const item = event.currentSelectItemName
      ? items.find(entry => entry.label === event.currentSelectItemName)
      : items[event.currentSelectItemIndex ?? 0]
    if (!item) return
    if (item.action === 'launcher') { void this.exitToLauncher(0); return }
    this.menu = null
    this.draw()
    switch (item.action) {
      case 'back': this.showReader(); break
      case 'cancel': {
        const { thread, task } = this.view
        if (thread && task && task.kind === menu.task?.kind && task.id === menu.task.id) {
          void this.cancelTask(thread, task).catch((error: unknown) =>
            this.onError(error instanceof Error ? error.message : 'Could not cancel the task'))
        }
        break
      }
      case 'send': {
        if (this.stage !== 'stopping') { void this.tap(); break }
        // Local storage may have filled while the menu was open.
        const version = this.revision
        void this.micCleanup.then(() => { if (version === this.revision) void this.sendClip() })
        break
      }
      case 'discard': this.reset('reader'); break
    }
  }

  private async tap() {
    if (this.stage === 'recording') return this.finishRecording(true)
    if (this.stage === 'review') return this.sendClip()
    if (this.stage === 'quiet') { this.showReader(); return }
    if (this.stage !== 'reader') return
    if (!this.view.canRecord || !this.view.thread || this.view.pending) { this.refresh(); return }
    this.stage = 'starting'
    this.note = ''
    this.draw()
    const version = ++this.revision
    // If the account changes while audioControl(true) is in flight, turn off
    // that microphone before a new capture is allowed to open it again.
    this.micCleanup = this.micCleanup.then(async () => {
      if (version !== this.revision) return
      const onStorageFailure = () => {
        if (version === this.revision) void this.finishRecording(false)
      }
      const recorder = await startRecording(this.bridge, onStorageFailure, () => {
        if (this.stage === 'recording' && !this.menu) this.draw()
      })
      if (version !== this.revision) { await recorder.cancel(); return }
      this.recorder = recorder
      this.stage = 'recording'
      if (recorder.recording.storageFailed) onStorageFailure()
    }).catch(() => {
      if (version === this.revision) {
        this.onError('Microphone unavailable')
        this.showReader('Microphone unavailable')
      }
    })
    await this.micCleanup
    this.draw()
  }

  private async finishRecording(send: boolean) {
    const recorder = this.recorder
    if (!recorder || this.stage !== 'recording') return
    const version = this.revision
    this.recorder = null
    this.stage = 'stopping'
    this.draw()
    try {
      const stopped = recorder.stop()
      this.micCleanup = stopped.then(() => undefined, () => undefined)
      const audio = await stopped
      if (version !== this.revision) { await audio?.discard(); return }
      if (!audio) { this.showReader('No audio captured') }
      else {
        this.clip = audio
        this.stage = 'review'
        if (send) return this.sendClip()
        this.note = 'Storage unavailable · tap to send'
        this.onError('Recording stopped because local storage is unavailable. Tap to send the captured audio.')
      }
    } catch {
      if (version === this.revision) { this.showReader('Recording failed') }
    }
    this.draw()
  }

  private async sendClip() {
    if (!this.clip || !this.view.thread || this.stage !== 'review') return
    const version = this.revision
    const clip = this.clip
    this.clip = null // The send owns the staged PCM until all WAVs have uploaded.
    const lastSeqId = this.view.messages.at(-1)?.seqId ?? 0
    this.stage = 'sending'
    this.draw()
    try {
      const result = await this.send(this.view.thread, clip)
      if (version !== this.revision) return
      if (result === 'sent' && (this.view.messages.at(-1)?.seqId ?? 0) <= lastSeqId) this.sentAfter = lastSeqId
      this.showReader(result === 'pending' ? 'Checking delivery…' : '')
    } catch (error) {
      if (version !== this.revision) return
      this.clip = clip
      this.onError(error instanceof Error ? error.message : 'Send failed')
      this.note = 'Send failed'
      this.stage = 'review'
    } finally {
      if (this.clip !== clip) this.discard(clip)
    }
    this.draw()
  }

  private page(): LensPage {
    const latest = this.view.messages.at(-1)
    const mode = this.stage === 'reader' || this.stage === 'quiet' ? this.stage : 'voice'
    const lastReply = this.view.messages.findLast(message => message.role === 'assistant')
    const working = this.view.task !== null || this.sentAfter !== null
    const unread = (lastReply?.seqId ?? 0) > this.readSeq
    const indicator = working ? 'working' : unread && (mode !== 'reader' || this.menu) ? 'unread' : 'off'
    let body = '', status = '', hint = ''
    switch (this.stage) {
      case 'quiet': break
      case 'reader':
        if (working || latest?.role === 'user') status = '● Thinking'
        if (latest?.role === 'assistant') body = this.pages[this.pageIndex]
        else if (!status) body = this.note || this.view.status
        hint = this.view.canRecord && !this.view.pending ? 'Hold: menu · Tap to speak' : 'Hold: menu · Tap to refresh'
        break
      case 'starting': hint = 'Double-tap: discard'; break
      case 'recording':
        status = listeningLabel(this.recorder!.seconds)
        hint = 'Hold: menu · Tap: send · Double-tap: discard'
        break
      case 'stopping': status = '● Sending'; hint = 'Double-tap: discard'; break
      case 'sending': status = '● Sending'; hint = 'Double-tap: launcher'; break
      case 'review':
        body = this.note || 'Recording ready'
        hint = 'Hold: menu · Tap: send · Double-tap: discard'
        break
    }
    if (this.menu) hint = 'Swipe: choose · Tap: select · Double-tap: back'
    return { mode, menu: this.menu?.kind ?? null, body, status, hint, indicator }
  }

  private animateWork(enabled: boolean) {
    if (typeof document !== 'undefined') document.documentElement?.classList.toggle('lens-working', enabled)
    if (!enabled) this.dim = false
  }

  private draw() {
    if (this.closed || !this.active || !this.unsubscribe) return
    this.renderQueue = this.renderQueue.then(async () => {
      if (this.closed || !this.active) return
      const page = this.page()
      const key = JSON.stringify([page.menu, page.mode, page.body, !!page.status, page.hint])
      // PCM crosses one whole second per phase: bright for one second, dim
      // for one second. No callbacks run just to animate an idle WebView.
      const recording = this.stage === 'recording' && !!this.recorder
      this.animateWork(!recording && (page.indicator === 'working' || !!page.status))
      const dim = recording ? this.recorder!.seconds % 2 === 1 : this.dim
      const level = page.status || page.indicator !== 'off' ? (dim ? 2 : 4) : 0
      const thread = this.view.thread, latest = this.view.messages.at(-1)
      if (key !== this.lastPage) {
        if (!await this.bridge.rebuildPageContainer(lensPage(page, level))) throw new Error('Could not update the G2 display')
        this.lastPage = key
      } else if (page.status && (this.lastStatus !== page.status || level !== this.lastDotLevel)) {
        if (!await this.bridge.textContainerUpgrade(statusUpdate(page.status, level))) throw new Error('Could not update the G2 recording status')
      } else if (level !== this.lastDotLevel) {
        if (!await this.bridge.textContainerUpgrade(indicatorUpdate(level))) throw new Error('Could not update the G2 indicator')
      }
      this.lastStatus = page.status
      this.lastDotLevel = level
      if (this.closed || !this.active) return
      if (page.mode === 'reader' && !page.menu && this.stage === 'reader' && !this.menu &&
          thread && this.view.thread === thread && latest?.role === 'assistant' && latest.seqId > this.readSeq &&
          this.view.messages.at(-1)?.id === latest.id && this.sentAfter === null) {
        this.readSeq = latest.seqId
        try { localStorage.setItem(readKey(thread), String(this.readSeq)) }
        catch { /* The in-memory cursor still applies to this session. */ }
      }
    }).catch((error: Error) => {
      this.lastPage = ''
      this.onError(error.message)
    })
  }
}
