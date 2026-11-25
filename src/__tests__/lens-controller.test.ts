import { afterEach, describe, expect, it, vi } from 'vitest'
import { OsEventTypeList as Gesture, type EvenAppBridge, type EvenHubEvent, type RebuildPageContainer } from '@evenrealities/even_hub_sdk'
import { LensController, type LensView } from '../lens/controller'

const ready: LensView = { thread: 'bound', messages: [], status: '', canRecord: true, pending: false }

async function setup(open = async () => true) {
  const listeners = new Set<(event: EvenHubEvent) => void>()
  const pages: string[] = []
  const bridge = {
    createStartUpPageContainer: vi.fn(async () => 0),
    rebuildPageContainer: vi.fn(async (p: RebuildPageContainer) => {
      pages.push(p.textObject!.map((v) => v.content).join('\n')); return true
    }),
    audioControl: vi.fn((enabled: boolean) => enabled ? open() : Promise.resolve(true)),
    onEvenHubEvent: (cb: (e: EvenHubEvent) => void) => { listeners.add(cb); return () => { listeners.delete(cb) } },
    shutDownPageContainer: vi.fn(async () => true),
  }
  const send = vi.fn(async (_thread: string, _audio: Blob) => 'sent' as const)
  const controller = new LensController(bridge as unknown as EvenAppBridge, send, vi.fn(), vi.fn())
  controller.update(ready)
  await controller.start()
  const emit = (e: unknown) => listeners.forEach((cb) => cb(e as EvenHubEvent))
  const tap = (eventType?: Gesture) => emit({ textEvent: { eventType } })
  const frame = () => emit({ audioEvent: { audioPcm: new Uint8Array([1, 0, 2, 0]) } })
  const shows = (text: string) => vi.waitFor(() => expect(pages.at(-1)).toContain(text), { interval: 1 })
  return { controller, bridge, send, emit, tap, frame, shows }
}

afterEach(() => vi.useRealTimers())

describe('glasses controls', () => {
  it('sends the actual PCM as a WAV to the displayed thread on the second tap', async () => {
    const g = await setup()
    try {
      g.frame(); g.emit({})
      expect(g.bridge.audioControl).not.toHaveBeenCalled()
      g.tap()
      await g.shows('Listening…')
      g.frame(); g.frame(); g.tap()
      await vi.waitFor(() => expect(g.send).toHaveBeenCalledTimes(1))
      const [thread, audio] = g.send.mock.calls[0]!
      expect(thread).toBe('bound')
      expect(audio.type).toBe('audio/wav')
      const bytes = new Uint8Array(await audio.arrayBuffer())
      expect(new DataView(bytes.buffer).getUint32(24, true)).toBe(16000)
      expect([...bytes.slice(44)]).toEqual([1, 0, 2, 0, 1, 0, 2, 0])
      expect(g.bridge.audioControl).toHaveBeenLastCalledWith(false)
    } finally { g.controller.close() }
  })

  it('discards a cancelled recording and guards against a workspace change while the mic opens', async () => {
    let release!: () => void
    const g = await setup(() => new Promise((r) => { release = () => r(true) }))
    try {
      g.tap()
      await vi.waitFor(() => expect(release).toBeDefined())
      g.controller.update({ ...ready, thread: 'other-workspace' })
      release()
      await vi.waitFor(() => expect(g.bridge.audioControl).toHaveBeenLastCalledWith(false))
      g.frame()
      expect(g.send).not.toHaveBeenCalled()
      g.tap()
      await vi.waitFor(() => expect(g.bridge.audioControl).toHaveBeenCalledTimes(3))
      release()
      await g.shows('Listening…')
      g.frame(); g.tap(Gesture.DOUBLE_CLICK_EVENT)
      await g.shows('No messages yet')
      expect(g.send).not.toHaveBeenCalled()
    } finally { g.controller.close() }
  })

  it('opens the latest reply and allows paging without jumping away from a page being read', async () => {
    const g = await setup()
    try {
      const first = { id: 'reply', role: 'assistant' as const, text: 'a'.repeat(216) + 'end', seqId: 4 }
      g.controller.update({ ...ready, messages: [first] })
      await g.shows('1/2')
      g.tap(Gesture.SCROLL_BOTTOM_EVENT)
      await g.shows('end')
      g.controller.update({ ...ready, messages: [first, { ...first, id: 'new', text: 'New reply', seqId: 5 }] })
      await g.shows('2/2')
      g.tap(Gesture.SCROLL_BOTTOM_EVENT)
      await g.shows('New reply')
    } finally { g.controller.close() }
  })
})
