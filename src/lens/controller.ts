import { OsEventTypeList as Gesture, type EvenAppBridge, type EvenHubEvent } from '@evenrealities/even_hub_sdk'
import { getTextWidth } from '@evenrealities/pretext'
import type { RecordedVoice } from './recording'
import { startRecording, type Recorder } from './audio'
import type { LensReply, TaskTarget } from './messages'
import { indicatorUpdate, listeningLabel, statusUpdate, startupPage, lensPage, menuItems, paginate, type LensPage } from './screens'

export interface LensView {
  thread: string | null
  reply: LensReply | null
  working: boolean
  task: TaskTarget | null
  status: string
  canRecord: boolean
  pending: boolean
}

type Stage = 'quiet' | 'reader' | 'starting' | 'recording' | 'stopping' | 'review' | 'sending'
type Voice = (target: string, audio: RecordedVoice) => Promise<'sent' | 'pending'>

export class LensController {
  private view: LensView = { thread: null, reply: null, working: false, task: null, status: '', canRecord: false, pending: false }
  private stage: Stage = 'quiet'
  private menu: { task: TaskTarget | null } | null = null
  private readSeq = 0
  private pages: string[] = ['']
  private pageIndex = 0
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
    const { reply } = view
    const changedReply = changedThread || reply?.id !== this.view.reply?.id || reply?.text !== this.view.reply?.text
    this.view = view
    if (view.pending) this.menu = null
    if (changedThread) {
      this.readSeq = 0
      this.reset('quiet')
    }
    if (changedReply) {
      this.pageIndex = 0
      this.pages = reply ? paginate(reply.text) : ['']
      if (this.stage === 'reader') this.note = ''
    }
    this.draw()
  }

  private get screenStage(): Exclude<Stage, 'stopping'> {
    if (this.stage === 'stopping' || (this.stage === 'reader' && this.view.pending)) return 'sending'
    return this.stage
  }

  close() {
    this.closed = true
    if (typeof document !== 'undefined') document.documentElement?.removeEventListener('animationiteration', this.heartbeat)
    this.animateWork(false)
    this.unsubscribe?.()
    this.reset('quiet')
  }

  private reset(next: 'quiet' | 'reader') {
    this.revision++
    if (this.recorder) {
      this.micCleanup = this.recorder.cancel().catch(() => this.onError('Could not close the microphone'))
    }
    this.recorder = null
    this.clip = null
    this.menu = null
    this.stage = next
    this.note = ''
    if (next === 'quiet') this.pageIndex = 0
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
      if (type === Gesture.ABNORMAL_EXIT_EVENT) console.warn('Even App reported an abnormal G2 exit', this.screenStage)
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
    if (type === Gesture.SCROLL_TOP_EVENT || type === Gesture.SCROLL_BOTTOM_EVENT) {
      if (this.stage === 'quiet') return
      const step = type === Gesture.SCROLL_TOP_EVENT ? -1 : 1
      this.pageIndex = Math.max(0, Math.min(this.pages.length - 1, this.pageIndex + step))
      this.draw()
      return
    }
    if (this.screenStage === 'sending') return
    if (type === Gesture.LONG_PRESS_EVENT) {
      if (this.stage === 'reader') {
        this.menu = { task: this.view.task }
        this.draw()
      }
    } else if (type === Gesture.DOUBLE_CLICK_EVENT) {
      if (this.stage === 'quiet') void this.exitToLauncher(1)
      else if (this.stage === 'reader') this.reset('quiet')
      else this.reset('reader')
    } else if (type === Gesture.CLICK_EVENT) {
      void this.tap()
    }
  }

  private selectAction(event: NonNullable<EvenHubEvent['listEvent']>) {
    const menu = this.menu
    if (!menu || (event.containerID !== undefined && event.containerID !== 5)) return
    const items = menuItems()
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
    }
  }

  private async tap() {
    if (this.stage === 'recording') return this.finishRecording()
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
      const recorder = await startRecording(this.bridge, () => {
        if (this.stage === 'recording') this.draw()
      })
      if (version !== this.revision) { await recorder.cancel(); return }
      this.recorder = recorder
      this.stage = 'recording'
    }).catch(() => {
      if (version === this.revision) {
        this.onError('Microphone unavailable')
        this.showReader('Microphone unavailable')
      }
    })
    await this.micCleanup
    this.draw()
  }

  private async finishRecording() {
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
      if (version !== this.revision) return
      if (!audio) { this.showReader('No audio captured') }
      else {
        this.clip = audio
        this.stage = 'review'
        return this.sendClip()
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
    this.stage = 'sending'
    this.draw()
    try {
      await this.send(this.view.thread, clip)
      if (version !== this.revision) return
      this.showReader()
    } catch (error) {
      if (version !== this.revision) return
      this.clip = clip
      this.onError(error instanceof Error ? error.message : 'Send failed')
      this.note = 'Send failed'
      this.stage = 'review'
    }
    this.draw()
  }

  private page(): LensPage {
    const mode = this.stage === 'reader' || this.stage === 'quiet' ? this.stage : 'voice'
    const stage = this.screenStage
    const working = this.view.working || this.view.pending || stage === 'sending'
    const unread = (this.view.reply?.seqId ?? 0) > this.readSeq
    const indicator = working ? 'working' : unread && (mode !== 'reader' || this.menu) ? 'unread' : 'off'
    const body = mode === 'quiet' ? '' : this.pages[this.pageIndex]
    const scrollHint = mode === 'quiet' || this.menu ? '' : [
      this.pageIndex > 0 ? '∧' : '', this.pageIndex + 1 < this.pages.length ? '∨' : '',
    ].filter(Boolean).join(' ')
    let status = '', primaryHint = '', secondaryHint = ''
    switch (stage) {
      case 'quiet': break
      case 'reader':
        status = working ? '● Working' : this.note || this.view.status
        primaryHint = this.view.canRecord ? 'Tap to speak' : 'Tap to refresh'
        secondaryHint = 'Hold: menu'
        break
      case 'starting': secondaryHint = 'Double-tap: discard'; break
      case 'recording':
      case 'review':
        if (this.stage === 'recording') status = listeningLabel(this.recorder!.seconds)
        else status = this.note || 'Recording ready'
        primaryHint = 'Tap to send'
        secondaryHint = 'Double-tap: discard'
        break
      case 'sending':
        status = '● Sending'
        break
    }
    if (this.menu) {
      primaryHint = 'Tap to select'
      secondaryHint = 'Swipe: choose · Double-tap: back'
    }
    return { mode, menu: !!this.menu, body, status, primaryHint, scrollHint, secondaryHint, indicator }
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
      const key = JSON.stringify([page.menu, page.mode, page.body, getTextWidth(page.status), page.primaryHint, page.scrollHint, page.secondaryHint])
      // PCM crosses one whole second per phase: bright for one second, dim
      // for one second. No callbacks run just to animate an idle WebView.
      const recording = this.stage === 'recording' && !!this.recorder
      this.animateWork(!recording && page.indicator === 'working')
      const dim = recording ? this.recorder!.seconds % 2 === 1 : this.dim
      const level = page.status || page.indicator !== 'off' ? (dim ? 2 : 4) : 0
      const { thread, reply } = this.view
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
          thread && this.view.thread === thread && reply && reply.seqId > this.readSeq && this.view.reply?.id === reply.id) {
        this.readSeq = reply.seqId
      }
    }).catch((error: Error) => {
      this.lastPage = ''
      this.onError(error.message)
    })
  }
}
