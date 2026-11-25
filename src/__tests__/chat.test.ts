import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OkouApiClient } from '../api/client'
import { DeviceStore } from '../store'
import { DeviceChat, initialChat, type ChatState } from '../sync/engine'
import { readHistory } from '../sync/messages'
import { watchThread } from '../sync/realtime'
import type { ChatEventRow } from '../types'

vi.mock('../sync/realtime', () => ({ watchThread: vi.fn(() => () => {}) }))
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

const api = () => new OkouApiClient(async () => 'fixture-bearer', new AbortController().signal)
const identity = () => ({ userId: 'user_' + crypto.randomUUID(), orgId: 'org_fixture' })
const ok = (body: unknown) => Response.json(body)
const fail = (status: number, code = 'ERROR') => Response.json({ error: { code } }, { status })
const meta = (id: string) => ({ id, computerUseHostId: null, cloudBrowserEnabled: true })
const tail = (rows: ChatEventRow[], last = rows.at(-1), hasMore = false) => ok({
  rows, hasMore, cursor: { lastSeqId: last?.seqId ?? 0, lastEventId: last?.id ?? null },
})
function row(chatThreadId: string, seqId: number, fields: Partial<ChatEventRow> = {}): ChatEventRow {
  return { id: crypto.randomUUID(), chatThreadId, seqId, runId: null, revokesEventId: null,
    eventType: 'output.message', payload: { content: 'Hello' }, createdAt: new Date().toISOString(), ...fields }
}

describe('fixed conversation', () => {
  it('uses the same reserved UUID after a lost create response, including concurrent opens', async () => {
    const owner = identity(), ids: string[] = []
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      ids.push(JSON.parse(String(init.body)).clientThreadId)
      if (ids.length === 1) throw new TypeError('Lost response')
      return ok({ id: ids.at(-1) })
    })
    vi.stubGlobal('fetch', fetch)
    await expect(new DeviceStore(owner).fixedThread(api())).rejects.toThrow('Lost')
    const actual = await Promise.all([new DeviceStore(owner).fixedThread(api()), new DeviceStore(owner).fixedThread(api())])
    expect(new Set([...ids, ...actual]).size).toBe(1)
    fetch.mockImplementation(async () => ok(meta(ids[0])))
    expect(await new DeviceStore(owner).fixedThread(api())).toBe(ids[0])
  })

  it('isolates bindings and replaces only after an authoritative metadata miss', async () => {
    const owner = identity(), store = new DeviceStore(owner)
    let status = 503
    const newIds: string[] = []
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      if (!init.body) return fail(status)
      const { clientThreadId, title } = JSON.parse(String(init.body)); newIds.push(clientThreadId)
      expect(title).toBe('Even G2')
      return ok({ id: clientThreadId })
    })
    const first = await store.fixedThread(api())
    for (status of [503, 401, 403]) await expect(store.fixedThread(api())).rejects.toMatchObject({ status })
    expect(newIds).toEqual([first])
    status = 410
    const second = await store.fixedThread(api())
    const another = await new DeviceStore({ ...owner, orgId: 'org_2' }).fixedThread(api())
    expect(new Set([first, second, another]).size).toBe(3)
  })
})

describe('single-thread reader', () => {
  it('validates the archive and drains the tail using paired cursors without sharing credentials with storage', async () => {
    const id = crypto.randomUUID(), pending = crypto.randomUUID()
    const a = row(id, 12), b = row(id, 19, { eventType: 'input.prompt', revokesEventId: pending })
    const signed = 'https://storage.example/fixture'
    vi.stubGlobal('fetch', async (url: string | URL, init: RequestInit) => {
      const path = String(url)
      if (path === signed) {
        expect(init.credentials).toBe('omit')
        expect(init.headers).toBeUndefined()
        return new Response(JSON.stringify(a) + '\n')
      }
      if (path.endsWith('event-snapshot')) return ok({ url: signed, lastEventId: a.id, lastSeqId: 12 })
      if (path.includes('sinceSeqId=12')) {
        expect(path).toContain('sinceEventId=' + a.id)
        return tail([b], b, true)
      }
      expect(path).toContain('sinceEventId=' + b.id)
      return tail([], b)
    })
    expect(await readHistory(api(), id, null, pending)).toMatchObject({ rows: [a, b], acknowledged: true })
  })

  it('rebuilds an expired cursor and rejects a row from a different thread', async () => {
    const id = crypto.randomUUID(), old = row(id, 1)
    const fetch = vi.fn().mockResolvedValueOnce(fail(410))
      .mockResolvedValueOnce(fail(404, 'CHAT_EVENT_SNAPSHOT_NOT_FOUND'))
      .mockResolvedValueOnce(tail([row(crypto.randomUUID(), 2)]))
    vi.stubGlobal('fetch', fetch)
    await expect(readHistory(api(), id, { rows: [old], cursor: { lastSeqId: 1, lastEventId: old.id } })).rejects.toThrow('Invalid chat history')
    expect(fetch).toHaveBeenCalledTimes(3)
  })
})

describe('cancel current task', () => {
  it('sends the control for the current run or queued input only in the bound conversation', async () => {
    const runId = crypto.randomUUID(), eventId = crypto.randomUUID()
    const controlPosts: Record<string, unknown>[] = []
    let thread = '', rows: ChatEventRow[] = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname
      if (path === '/api/chat-threads') {
        thread = JSON.parse(String(init.body)).clientThreadId
        rows = [row(thread, 1, { runId, eventType: 'input.prompt' }),
          row(thread, 2, { id: eventId, eventType: 'input.prompt' })]
        return ok({ id: thread })
      }
      if (path.endsWith('/event-snapshot')) return fail(404, 'CHAT_EVENT_SNAPSHOT_NOT_FOUND')
      if (path.endsWith('/event-rows')) {
        const since = Number(new URL(url).searchParams.get('sinceSeqId'))
        return tail(rows.filter(r => r.seqId > since), rows.at(-1))
      }
      if (path === '/api/chat/events') {
        const body = JSON.parse(String(init.body))
        controlPosts.push(body)
        rows.push(body.interruptsRunId ? row(thread, 3, { runId, eventType: 'control.interrupt' })
          : row(thread, 4, { revokesEventId: eventId, eventType: 'control.revoke' }))
        return ok({ threadId: thread })
      }
      throw new Error('Unexpected route ' + path)
    })
    const chat = new DeviceChat(identity(), async () => 'fixture', () => {})
    try {
      await chat.start()
      await expect(chat.cancelTask('other-thread', { kind: 'run', id: runId })).rejects.toThrow()
      await chat.cancelTask(thread, { kind: 'event', id: eventId })
      expect(controlPosts).toHaveLength(0)
      await chat.cancelTask(thread, { kind: 'run', id: runId })
      await chat.refresh()
      await chat.cancelTask(thread, { kind: 'run', id: runId })
      await chat.cancelTask(thread, { kind: 'event', id: eventId })
      await chat.refresh()
      await chat.cancelTask(thread, { kind: 'event', id: eventId })
      expect(controlPosts).toEqual([
        { threadId: thread, clientEventId: expect.any(String), interruptsRunId: runId },
        { threadId: thread, clientEventId: expect.any(String), revokesEventId: eventId },
      ])
    } finally { chat.close() }
  })
})

describe('voice delivery', () => {
  it('survives a lost send response, retries the exact clip on request, and reconciles its promoted input after reopening', async () => {
    const owner = identity(), file = crypto.randomUUID(), host = crypto.randomUUID()
    const uploadUrl = 'https://user-artifact-private-prod.98b0b14cee451004596479a689d2071b.r2.cloudflarestorage.com/clip'
    let thread = '', uploads = 0, rows: ChatEventRow[] = []
    const posts: Record<string, unknown>[] = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname
      if (path === '/api/chat-threads') { thread = JSON.parse(String(init.body)).clientThreadId; return ok({ id: thread }) }
      if (path.endsWith('/metadata')) return ok({ ...meta(thread), computerUseHostId: host, cloudBrowserEnabled: false })
      if (path.endsWith('/event-snapshot')) return fail(404, 'CHAT_EVENT_SNAPSHOT_NOT_FOUND')
      if (path.endsWith('/event-rows')) {
        const since = Number(new URL(url).searchParams.get('sinceSeqId'))
        return tail(rows.filter((r) => r.seqId > since), rows.at(-1))
      }
      if (path === '/api/uploads/prepare/private') return ok({ id: file, uploadUrl, uploadHeaders: { 'x-amz-meta-clip': 'g2' } })
      if (url === uploadUrl) {
        uploads++
        expect(init.method).toBe('PUT')
        expect(init.credentials).toBe('omit')
        expect(new Headers(init.headers).has('authorization')).toBe(false)
        expect(new Headers(init.headers).get('x-amz-meta-clip')).toBe('g2')
        return new Response(null, { status: 200 })
      }
      if (path === '/api/uploads/complete') return ok({ id: file })
      if (path === '/api/chat/events') {
        posts.push(JSON.parse(String(init.body))); throw new TypeError('Lost response')
      }
      throw new Error('Unexpected route ' + path)
    })
    let state: ChatState = initialChat
    const open = () => new DeviceChat(owner, async () => 'fixture', (s) => { state = s })
    let chat = open()
    try {
      await chat.start()
      const wav = new Blob([new Uint8Array(48)], { type: 'audio/wav' })
      await expect(chat.sendVoice(thread, wav)).resolves.toBe('pending')
      await chat.refresh(); chat.close(); chat = open(); await chat.start()
      expect(state.pending).toBe(true)
      expect(posts).toHaveLength(1)
      expect(posts[0]).toMatchObject({ threadId: thread, computerUseHostId: host, cloudBrowserEnabled: false,
        hasTextContent: false, prompt: '(see message parts)', userMessage: { version: 1, parts: [{ type: 'voice', clips: [{ fileId: file }] }] } })
      await chat.retryPending()
      expect(posts).toEqual([posts[0], posts[0]])
      expect(uploads).toBe(1)
      rows = [row(thread, 2, { eventType: 'input.prompt', revokesEventId: String(posts[0].clientEventId) }),
        row(thread, 3, { payload: { content: 'The reply' } })]
      vi.mocked(watchThread).mock.calls.at(-1)![3]()
      await chat.refresh()
      expect(state.pending).toBe(false)
      expect(state.rows.at(-1)?.payload?.content).toBe('The reply')
      expect(posts).toHaveLength(2)
    } finally { chat.close() }
  })
})
