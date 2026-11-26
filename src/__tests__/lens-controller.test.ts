import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  OsEventTypeList as Gesture, type EvenAppBridge, type EvenHubEvent,
  type RebuildPageContainer, type TextContainerUpgrade,
} from '@evenrealities/even_hub_sdk'
import type { RecordedVoice } from '../lens/recording'
import { listeningLabel } from '../lens/screens'
import { LensController, type LensView } from '../lens/controller'
import type { LensMessage } from '../lens/messages'

const ready: LensView = { thread: 'bound', messages: [], task: null, status: '', canRecord: true, pending: false }
const task = { kind: 'run', id: 'running' } as const
const reply = (seqId: number, text: string): LensMessage => ({ id: String(seqId), seqId, role: 'assistant', text })

beforeEach(() => {
  vi.useFakeTimers()
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => store.get(key), setItem: (key: string, value: string) => store.set(key, value) })
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

async function setup(open = async () => true, stop = async () => true) {
  const listeners = new Set<(event: EvenHubEvent) => void>()
  let displayed: RebuildPageContainer
  const bridge = {
    createStartUpPageContainer: vi.fn(async () => 0),
    rebuildPageContainer: vi.fn(async (page: RebuildPageContainer) => { displayed = page; return true }),
    textContainerUpgrade: vi.fn(async (update: TextContainerUpgrade) => {
      const target = displayed.textObject!.find(box => box.containerID === update.containerID)!
      target.content = update.content?.trimEnd()
      target.textColor = update.textColor
      return true
    }),
    audioControl: vi.fn((enabled: boolean) => enabled ? open() : stop()),
    onEvenHubEvent: (cb: (e: EvenHubEvent) => void) => { listeners.add(cb); return () => { listeners.delete(cb) } },
    shutDownPageContainer: vi.fn(async () => true),
  }
  const sentWavs: Blob[] = []
  const send = vi.fn(async (_thread: string, audio: RecordedVoice) => {
    for (let index = 0; index < audio.fileCount; index++) sentWavs.push(await audio.file(index))
    return 'sent' as const
  })
  const cancel = vi.fn(async () => {})
  const error = vi.fn()
  const controller = new LensController(bridge as unknown as EvenAppBridge, send, vi.fn(), error, cancel)
  onTestFinished(() => controller.close())
  controller.update(ready)
  await controller.start()
  const settle = () => vi.advanceTimersByTimeAsync(0)
  const emit = (e: EvenHubEvent) => { for (const cb of listeners) cb(e); return settle() }
  const tap = (eventType?: Gesture) => emit({ sysEvent: { eventType } } as EvenHubEvent)
  const select = (index?: number) => emit({ listEvent: { containerID: 5, currentSelectItemIndex: index } } as EvenHubEvent)
  const frame = () => emit({ audioEvent: { audioPcm: new Uint8Array([1, 0, 2, 0]) } } as EvenHubEvent)
  const update = (patch: Partial<LensView>) => { controller.update({ ...ready, ...patch }); return settle() }
  const page = () => displayed
  const box = (name: string) => page().textObject?.find(v => v.containerName === name)
  const options = () => page().listObject?.[0]?.itemContainer?.itemName
  await settle()
  return { emit, controller, bridge, send, sentWavs, cancel, error, update, tap, select, frame, page, box, options }
}

describe('glasses reader', () => {
  it('opens blank, marks a reply read only after displaying it, and restores that cursor per thread', async () => {
    const g = await setup()
    const messages = [reply(2, 'This is the latest reply.')]
    expect(g.page().textObject!.every(v => !v.content)).toBe(true)
    await g.update({ messages })
    expect(g.page().textObject!.filter(v => v.content).map(v => v.containerName)).toEqual(['indicator'])
    g.bridge.rebuildPageContainer.mockResolvedValueOnce(false)
    await g.tap()
    expect(g.error).toHaveBeenCalled()
    await g.tap(Gesture.DOUBLE_CLICK_EVENT)
    expect(g.box('indicator')?.content).toBeTruthy()
    await g.tap()
    expect(g.box('body')?.content).toBe(messages[0].text)
    expect(g.box('title')?.content).toBe('OKOU')
    expect(g.box('voice-status')).toBeUndefined()
    await g.tap(Gesture.DOUBLE_CLICK_EVENT)
    expect(g.page().textObject!.every(v => !v.content)).toBe(true)
    g.controller.close()
    const reopened = await setup()
    await reopened.update({ messages })
    expect(reopened.box('indicator')?.content).toBe('')
    await reopened.update({ thread: 'another', messages })
    expect(reopened.box('indicator')?.content).toBeTruthy()
  })

  it('scrolls only the latest reply, keeps its position on refresh, and switches to a new reply immediately', async () => {
    const g = await setup()
    const lines = Array.from({ length: 18 }, (_, i) => 'Line ' + (i + 1))
    const messages = [reply(1, 'An old reply'), reply(2, lines.join('\n'))]
    await g.update({ messages })
    await g.tap()
    const first = g.box('body')?.content
    expect(first).toMatch(/^Line 1\n/)
    await g.tap(Gesture.SCROLL_TOP_EVENT)
    expect(g.box('body')?.content).toBe(first)
    await g.tap(Gesture.SCROLL_BOTTOM_EVENT)
    const middle = g.box('body')?.content
    expect(middle).not.toEqual(first)
    await g.update({ messages: [...messages], task })
    expect(g.box('body')?.content).toBe(middle)
    await g.tap(Gesture.SCROLL_TOP_EVENT)
    expect(g.box('body')?.content).toBe(first)
    for (let n = 0; n < 4; n++) await g.tap(Gesture.SCROLL_BOTTOM_EVENT)
    expect(g.box('body')?.content).toMatch(/Line 18$/)
    await g.update({ messages: [...messages, reply(3, 'New answer')] })
    await g.tap(Gesture.SCROLL_TOP_EVENT)
    expect(g.box('body')?.content).toBe('New answer')
  })

  it('renders Thinking... for the most recent user message even before a run is reported', async () => {
    const g = await setup()
    const prompt = { ...reply(2, 'private prompt'), role: 'user' } as const
    const messages = [reply(1, 'Older answer'), prompt]
    await g.update({ messages })
    await g.tap()
    await g.tap(Gesture.SCROLL_TOP_EVENT)
    expect(g.box('voice-status')?.content).toBe('● Thinking')
    expect(g.box('voice-status')?.yPosition).toBe(0)
    await g.update({ messages: [...messages, reply(3, 'Done.')], task })
    expect(g.box('body')?.content).toBe('Done.')
    expect(g.box('title')?.yPosition).toBe(g.box('voice-status')?.yPosition)
  })

  it('stops writing to the lens after system exit and redraws the current state on return', async () => {
    const g = await setup()
    await g.update({ task })
    await g.tap(Gesture.SYSTEM_EXIT_EVENT)
    const writes = g.bridge.textContainerUpgrade.mock.calls.length
    await g.update({ messages: [reply(1, 'Arrived after exit')] })
    await vi.advanceTimersByTimeAsync(3000)
    expect(g.bridge.textContainerUpgrade).toHaveBeenCalledTimes(writes)
    await g.tap(Gesture.FOREGROUND_ENTER_EVENT)
    expect(g.box('indicator')?.content).toBeTruthy()
    expect(g.box('title')).toBeUndefined()
  })

  it('uses the selected native menu action and never cancels a replacement task', async () => {
    const g = await setup()
    await g.update({ task })
    await g.tap()
    await g.tap(Gesture.LONG_PRESS_EVENT)
    await g.tap(Gesture.LONG_PRESS_RELEASE_EVENT)
    expect(g.options()).toEqual(['Cancel current task', 'Back to main menu', 'Back to Okou'])
    await g.update({ task: { ...task, id: 'next' } })
    await g.select()
    expect(g.cancel).not.toHaveBeenCalled()
    await g.tap(Gesture.LONG_PRESS_EVENT)
    await g.select()
    expect(g.cancel).toHaveBeenCalledExactlyOnceWith('bound', { ...task, id: 'next' })
    await g.tap(Gesture.LONG_PRESS_EVENT)
    await g.select(2)
    expect(g.box('title')?.content).toBe('OKOU')
    expect(g.bridge.shutDownPageContainer).not.toHaveBeenCalled()
    await g.tap(Gesture.LONG_PRESS_EVENT)
    await g.select(1)
    expect(g.bridge.shutDownPageContainer).toHaveBeenCalledExactlyOnceWith(0)
    expect(g.bridge.audioControl).not.toHaveBeenCalled()
  })
})

describe('glasses microphone', () => {
  it.each(['tap', 'menu'])('sends captured PCM as a WAV once through the %s action and shows Thinking...', async (action) => {
    const g = await setup()
    await g.frame()
    await g.tap()
    expect(g.bridge.audioControl).not.toHaveBeenCalled()
    await g.tap()
    expect(g.box('voice-status')?.content).toBe('● Listening 00:00')
    expect(g.box('body')?.content).toBe('')
    await g.frame(); await g.frame()
    if (action === 'menu') {
      await g.tap(Gesture.LONG_PRESS_EVENT)
      expect(g.options()).toEqual(['Send now', 'Discard message'])
      await g.select()
    } else await g.tap()
    expect(g.send).toHaveBeenCalledTimes(1)
    const [thread] = g.send.mock.calls[0]!
    const [audio] = g.sentWavs
    expect(thread).toBe('bound')
    expect(audio.type).toBe('audio/wav')
    const bytes = new Uint8Array(await audio.arrayBuffer())
    expect(new DataView(bytes.buffer).getUint32(24, true)).toBe(16000)
    expect([...bytes.slice(44)]).toEqual([1, 0, 2, 0, 1, 0, 2, 0])
    expect(g.bridge.audioControl).toHaveBeenLastCalledWith(false)
    expect(g.box('voice-status')?.content).toBe('● Thinking')
    expect(g.box('voice-status')?.yPosition).toBe(0)
    await g.update({ messages: [reply(1, 'Answer')] })
    expect(g.box('body')?.content).toBe('Answer')
  })

  it('keeps recording through phone suspension and past one minute, and discards on request', async () => {
    const g = await setup()
    await g.tap(); await g.tap(); await g.frame()
    await g.update({ messages: [reply(1, 'Arrived during recording')] })
    expect(g.box('voice-status')?.yPosition).toBe(g.box('title')?.yPosition)
    expect(g.box('voice-status')?.xPosition).toBeGreaterThan(g.box('title')!.xPosition!)
    await g.tap(Gesture.LONG_PRESS_EVENT)
    g.controller.suspend()
    await vi.advanceTimersByTimeAsync(65_000)
    expect(g.bridge.audioControl).toHaveBeenCalledTimes(1)
    expect(g.options()).toEqual(['Send now', 'Discard message'])
    await g.select(1)
    expect(g.box('body')?.content).toBe('Arrived during recording')
    await g.tap(Gesture.DOUBLE_CLICK_EVENT)
    expect(g.box('indicator')?.content).toBe('')
    expect(g.send).not.toHaveBeenCalled()
  })

  it('updates the anchored listening clock from captured PCM without rebuilding the page', async () => {
    const g = await setup()
    await g.tap(); await g.tap()
    await g.frame()
    await g.tap(Gesture.DOUBLE_CLICK_EVENT)
    await g.tap()
    const start = g.box('voice-status')!
    expect(start.content).toBe('● Listening 00:00')
    const builds = g.bridge.rebuildPageContainer.mock.calls.length
    const packet = (length: number) => g.emit({ audioEvent: { audioPcm: new Uint8Array(length) } } as EvenHubEvent)
    await packet(31_999)
    expect(start.content).toBe('● Listening 00:00')
    await packet(1)
    expect(start.content).toBe('● Listening 00:01')
    expect(start.textColor).toBe(2)
    expect(g.box('gesture-hint')?.content).toContain('Tap: send')
    expect(g.box('gesture-hint')?.yPosition).toBe(254)
    await packet(58 * 32_000)
    expect(start.content).toBe('● Listening 00:59')
    await packet(32_000)
    expect(start.content).toBe('● Listening 01:00')
    expect(start.textColor).toBe(4)
    expect(g.box('voice-status')).toBe(start)
    expect(g.bridge.rebuildPageContainer).toHaveBeenCalledTimes(builds)
    expect(listeningLabel(5999)).toBe('● Listening 99:59')
    expect(listeningLabel(6000)).toBe('● Listening 100:00')
  })

  it('sends the beginning and end of a take across the old cutoff', async () => {
    const g = await setup()
    await g.tap(); await g.tap(); await g.frame()
    await vi.advanceTimersByTimeAsync(61_000)
    await g.frame(); await g.tap()
    expect(g.send).toHaveBeenCalledTimes(1)
    expect([...new Uint8Array(await g.sentWavs[0].arrayBuffer()).slice(44)]).toEqual([1, 0, 2, 0, 1, 0, 2, 0])
  })

  it('keeps the whole recording available to an explicit send while the lens exits', async () => {
    const g = await setup()
    let resume!: () => void
    const paused = new Promise<void>(resolve => { resume = resolve })
    const delivered: Blob[] = []
    g.send.mockImplementationOnce(async (_thread, audio) => {
      await paused
      delivered.push(await audio.file(0))
      return 'sent'
    })
    await g.tap(); await g.tap(); await g.frame(); await g.tap()
    expect(g.box('voice-status')?.content).toBe('● Sending')
    expect(g.box('voice-status')?.yPosition).toBe(0)
    expect(g.box('gesture-hint')?.yPosition).toBe(254)
    await g.tap(Gesture.SYSTEM_EXIT_EVENT)
    resume()
    await vi.advanceTimersByTimeAsync(0)
    expect(delivered.map(wav => wav.size)).toEqual([48])
    expect(g.send).toHaveBeenCalledTimes(1)
  })

  it('closes an opening microphone when the workspace changes and discards on double-tap', async () => {
    let release!: () => void
    const g = await setup(() => new Promise<boolean>(resolve => { release = () => resolve(true) }))
    await g.tap(); await g.tap()
    await g.update({ thread: 'other-workspace' })
    release()
    await g.frame()
    expect(g.bridge.audioControl).toHaveBeenLastCalledWith(false)
    expect(g.box('title')).toBeUndefined()
    await g.tap(); await g.tap()
    release()
    await g.frame()
    expect(g.box('voice-status')?.content).toBe('● Listening 00:00')
    await g.tap(Gesture.DOUBLE_CLICK_EVENT)
    expect(g.box('title')?.content).toBe('OKOU')
    expect(g.box('voice-status')).toBeUndefined()
    expect(g.send).not.toHaveBeenCalled()
  })
})
