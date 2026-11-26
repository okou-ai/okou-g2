import 'fake-indexeddb/auto'
import { createStore, set } from 'idb-keyval'
import { UnsecuredJWT } from 'jose'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OkouApiClient } from '../api/client'
import { API_BASE_URL, CHAT_SCOPES, DEVICE_SCOPE, MCP_URL } from '../config'
import { DeviceStore } from '../store'
import { DeviceChat, initialChat, type ChatState } from '../sync/engine'
import { startRecording } from '../lens/audio'
import type { EvenAppBridge, EvenHubEvent } from '@evenrealities/even_hub_sdk'
import { RecordedVoice, PCM_SEGMENT_BYTES } from '../lens/recording'
import { readHistory } from '../sync/messages'
import { watchThread } from '../sync/realtime'
import type { ChatEventRow } from '../types'
import { rpc, toolResult } from './mcp-fixture'

vi.mock('../sync/realtime', () => ({ watchThread: vi.fn(() => () => {}) }))
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

const api = () => new OkouApiClient(async () => 'fixture-bearer', new AbortController().signal)
const identity = () => ({ userId: 'user_' + crypto.randomUUID(), orgId: 'org_fixture' })
function row(chatThreadId: string, seqId: number, fields: Partial<ChatEventRow> = {}): ChatEventRow {
  return { id: crypto.randomUUID(), chatThreadId, seqId, runId: null, revokesEventId: null,
    eventType: 'output.message', payload: { content: 'Hello' }, createdAt: new Date().toISOString(), ...fields }
}
function page(init: RequestInit, rows: ChatEventRow[], last = rows.at(-1), hasMore = false, snapshot: object | null = null) {
  return toolResult(init, { snapshot, hasMore,
    rows: rows.map(({ id: eventId, chatThreadId: threadId, ...event }) => ({ eventId, threadId, ...event })),
    cursor: { lastSeqId: last?.seqId ?? 0, lastEventId: last?.id ?? null } })
}
function tool(url: string, init: RequestInit) {
  expect(url).toBe(MCP_URL)
  expect(init).toMatchObject({ method: 'POST', credentials: 'omit', redirect: 'error' })
  const message = rpc(init)
  const headers = new Headers(init.headers)
  expect(headers.get('authorization')).toMatch(/^Bearer /)
  expect(headers.get('mcp-name')).toBe(message.params.name)
  expect(headers.get('mcp-method')).toBe('tools/call')
  expect(message).toMatchObject({ jsonrpc: '2.0', method: 'tools/call' })
  expect(message.params._meta['io.modelcontextprotocol/protocolVersion']).toBe(headers.get('mcp-protocol-version'))
  return message.params
}

describe('fixed conversation', () => {
  it('uses the same reserved UUID after a lost create response, including concurrent opens', async () => {
    const owner = identity(), ids: string[] = []
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      const call = tool(url, init)
      expect(call.name).toBe('create_chat_thread')
      ids.push(String(call.arguments.clientThreadId))
      if (ids.length === 1) throw new TypeError('Lost response')
      return toolResult(init, { threadId: call.arguments.clientThreadId })
    })
    vi.stubGlobal('fetch', fetch)
    await expect(new DeviceStore(owner).fixedThread(api())).rejects.toThrow('Lost')
    const actual = await Promise.all([new DeviceStore(owner).fixedThread(api()), new DeviceStore(owner).fixedThread(api())])
    expect(new Set([...ids, ...actual]).size).toBe(1)
    expect(await new DeviceStore(owner).fixedThread(api())).toBe(ids[0])
  })

  it('isolates workspace bindings and replaces a thread only on a confirmed MCP thread miss', async () => {
    const owner = identity(), created: string[] = []
    let failure: number | string = 0
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const call = tool(url, init)
      if (call.name === 'create_chat_thread') {
        const id = String(call.arguments.clientThreadId)
        expect(call.arguments.title).toBe('Even G2')
        created.push(id)
        return toolResult(init, { threadId: id })
      }
      expect(call.name).toBe('get_chat_messages')
      if (failure && call.arguments.threadId === created[0]) {
        return typeof failure === 'number' ? new Response(null, { status: failure })
          : toolResult(init, { error: { code: failure } }, true)
      }
      return page(init, [])
    })
    let state: ChatState = initialChat
    const chat = new DeviceChat(owner, async () => 'fixture', s => { state = s })
    try {
      await chat.start()
      const first = state.thread
      for (failure of [503, 401, 404, 'FORBIDDEN']) {
        await chat.refresh()
        expect(state.error).toContain('get_chat_messages')
        expect(created).toEqual([first])
      }
      failure = 'NOT_FOUND'
      await chat.refresh()
      expect(state.error).toBeNull()
      expect(state.thread).toBe(created[1])
      await new DeviceStore({ ...owner, orgId: 'org_other' }).fixedThread(api())
      expect(new Set(created).size).toBe(3)
    } finally { chat.close() }
  })
})

describe('single-thread reader', () => {
  it('combines the native archive and MCP event rows and follows the paired cursor', async () => {
    const id = crypto.randomUUID(), pending = crypto.randomUUID()
    const a = row(id, 12), b = row(id, 19, { eventType: 'input.prompt', revokesEventId: pending })
    const signed = 'https://storage.example/fixture'
    vi.stubGlobal('fetch', async (url: string | URL, init: RequestInit) => {
      if (String(url) === signed) {
        expect(init.credentials).toBe('omit')
        expect(init.headers).toBeUndefined()
        return new Response(JSON.stringify(a) + '\n')
      }
      const call = tool(String(url), init)
      expect(call.name).toBe('get_chat_messages')
      if (call.arguments.sinceSeqId === undefined) return page(init, [b], b, true, { url: signed, lastEventId: a.id, lastSeqId: 12 })
      expect(call.arguments).toMatchObject({ threadId: id, sinceSeqId: 19, sinceEventId: b.id })
      return page(init, [], b)
    })
    expect(await readHistory(api(), id, null, pending)).toMatchObject({ rows: [a, b], acknowledged: true })
  })

  it('renews an unavailable signed archive and keeps the snapshot cursor when history was compacted', async () => {
    const id = crypto.randomUUID(), history = row(id, 1), signed = 'https://storage.example/archive'
    let pointers = 0
    vi.stubGlobal('fetch', async (url: string | URL, init: RequestInit) => {
      if (String(url) === signed + '1') throw new TypeError('Failed to fetch')
      if (String(url) === signed + '2') return new Response(JSON.stringify(history) + '\n')
      const call = tool(String(url), init)
      expect(call.arguments.sinceSeqId).toBeUndefined()
      return page(init, [], history, false, { url: signed + ++pointers, lastEventId: history.id, lastSeqId: 1 })
    })
    expect((await readHistory(api(), id, null)).rows).toEqual([history])
    expect(pointers).toBe(2)
  })

  it('reports a persistently blocked archive without skipping rows or reopening from zero', async () => {
    const id = crypto.randomUUID(), history = row(id, 1), signed = 'https://storage.example/blocked'
    vi.stubGlobal('fetch', async (url: string | URL, init: RequestInit) => {
      if (String(url) === signed) throw new TypeError('Failed to fetch')
      expect(tool(String(url), init).arguments.sinceSeqId).toBeUndefined()
      return page(init, [], history, false, { url: signed, lastEventId: history.id, lastSeqId: 1 })
    })
    await expect(readHistory(api(), id, null)).rejects.toThrow('chat history snapshot (network or cross-origin access)')
  })

  it('rebuilds an expired cursor and rejects a row belonging to another thread', async () => {
    const id = crypto.randomUUID(), old = row(id, 1)
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      const call = tool(url, init)
      return call.arguments.sinceEventId ? toolResult(init, { error: { code: 'CHAT_EVENTS_EXPIRED' } }, true)
        : page(init, [row(crypto.randomUUID(), 2)])
    })
    vi.stubGlobal('fetch', fetch)
    await expect(readHistory(api(), id, { rows: [old], cursor: { lastSeqId: 1, lastEventId: old.id } })).rejects.toThrow('Invalid chat history')
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})

describe('cancel current task', () => {
  it('calls the matching tool only for the current run or queued input in the bound conversation', async () => {
    const runId = crypto.randomUUID(), eventId = crypto.randomUUID()
    const controls: object[] = []
    let thread = '', rows: ChatEventRow[] = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const call = tool(url, init)
      if (call.name === 'create_chat_thread') {
        thread = String(call.arguments.clientThreadId)
        rows = [row(thread, 1, { runId, eventType: 'input.prompt' }), row(thread, 2, { id: eventId, eventType: 'input.prompt' })]
        return toolResult(init, { threadId: thread })
      }
      if (call.name === 'get_chat_messages') return page(init, rows.filter(r => r.seqId > Number(call.arguments.sinceSeqId ?? 0)), rows.at(-1))
      controls.push({ name: call.name, args: call.arguments })
      rows.push(call.name === 'cancel_run' ? row(thread, 3, { runId, eventType: 'control.interrupt' })
        : row(thread, 4, { revokesEventId: eventId, eventType: 'control.revoke' }))
      return toolResult(init, {})
    })
    let scope = CHAT_SCOPES.join(' ')
    const chat = new DeviceChat(identity(), async () => new UnsecuredJWT({ scope }).encode(), () => {})
    try {
      await chat.start()
      await expect(chat.cancelTask('other-thread', { kind: 'run', id: runId })).rejects.toThrow()
      await chat.cancelTask(thread, { kind: 'event', id: eventId })
      await expect(chat.cancelTask(thread, { kind: 'run', id: runId })).rejects.toThrow('sign in again to grant permission')
      expect(controls).toHaveLength(0)
      scope = DEVICE_SCOPE
      await chat.cancelTask(thread, { kind: 'run', id: runId })
      await chat.refresh()
      await chat.cancelTask(thread, { kind: 'run', id: runId })
      await chat.cancelTask(thread, { kind: 'event', id: eventId })
      await chat.refresh()
      await chat.cancelTask(thread, { kind: 'event', id: eventId })
      expect(controls).toEqual([
        { name: 'cancel_run', args: { runId } }, { name: 'revoke_queued_message', args: { threadId: thread, eventId } },
      ])
    } finally { chat.close() }
  })
})

describe('voice delivery', () => {
  it('spools a continuous 14-minute take, retries only the unfinished WAV and sends one ordered input', async () => {
    const owner = identity(), files: string[] = [crypto.randomUUID(), crypto.randomUUID()]
    const storage = 'https://user-artifact-private-prod.98b0b14cee451004596479a689d2071b.r2.cloudflarestorage.com/'
    const actions: string[] = [], uploads: number[] = []
    let thread = '', failSecond = true
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      if (url.startsWith(storage)) {
        const file = files.indexOf(url.slice(storage.length))
        uploads.push(file)
        if (file === 1 && failSecond) { failSecond = false; return new Response(null, { status: 503 }) }
        const data = new Uint8Array(await (init.body as Blob).arrayBuffer())
        expect(new DataView(data.buffer).getUint32(40, true)).toBe(data.length - 44)
        const segments = file === 0 ? 54 : 2
        expect(data.length).toBe(44 + PCM_SEGMENT_BYTES * segments + (file === 1 ? 2 : 0))
        for (let i = 0; i < segments; i++) {
          const value = i + (file === 0 ? 0 : 54)
          const chunk = data.subarray(44 + i * PCM_SEGMENT_BYTES, 44 + (i + 1) * PCM_SEGMENT_BYTES)
          expect(chunk.every(byte => byte === value)).toBe(true)
        }
        if (file === 1) expect([...data.slice(-2)]).toEqual([213, 47])
        return new Response(null, { status: 200 })
      }
      const { name, arguments: args } = tool(url, init)
      if (name === 'create_chat_thread') { thread = String(args.clientThreadId); return toolResult(init, { threadId: thread }) }
      if (name === 'get_chat_messages') return page(init, [])
      actions.push(name)
      if (name === 'prepare_voice_upload') {
        const file = files[Number(args.size) > PCM_SEGMENT_BYTES * 3 ? 0 : 1]
        return toolResult(init, { id: file, uploadUrl: storage + file })
      }
      if (name === 'complete_voice_upload') return toolResult(init, { id: args.id })
      expect(name).toBe('send_chat_message')
      expect(args.userMessage).toEqual({ version: 1, parts: files.map(fileId => ({ type: 'voice', clips: [{ fileId }] })) })
      return toolResult(init, { threadId: thread, eventId: args.clientEventId })
    })
    let listener!: (event: EvenHubEvent) => void
    const bridge = { audioControl: vi.fn(async () => true), onEvenHubEvent: (handler: typeof listener) => {
      listener = handler
      return () => {}
    } } as unknown as EvenAppBridge
    const storageError = vi.fn()
    const chat = new DeviceChat(owner, async () => 'fixture', () => {})
    await chat.start()
    const recorder = await startRecording(bridge, storageError)
    const feed = (bytes: Uint8Array) => listener({ audioEvent: { audioPcm: bytes } } as EvenHubEvent)
    try {
      // One host frame crosses each 15-second boundary, including a split PCM sample.
      let carry = new Uint8Array()
      for (let i = 0; i < 56; i++) {
        const data = new Uint8Array(PCM_SEGMENT_BYTES).fill(i)
        const frame = new Uint8Array(carry.length + data.length - 1)
        frame.set(carry); frame.set(data.subarray(0, -1), carry.length)
        feed(frame)
        carry = data.slice(-1)
      }
      feed(new Uint8Array([carry[0], 213, 47]))
      const draft = (await recorder.stop())!
      expect(storageError).not.toHaveBeenCalled()
      expect(draft.fileCount).toBe(2)
      expect(actions).toHaveLength(0)
      await expect(chat.sendVoice(thread, draft)).rejects.toThrow('503')
      await expect(chat.sendVoice(thread, draft)).resolves.toBe('sent')
      expect(uploads).toEqual([0, 1, 1])
      expect(actions.filter(action => action === 'send_chat_message')).toHaveLength(1)
    } finally { await recorder.recording.discard(); chat.close() }
  })

  it('restores the original file and event IDs of a pending send saved before segmented capture', async () => {
    const owner = identity(), thread = crypto.randomUUID()
    const receipt = { clientEventId: crypto.randomUUID(), fileId: crypto.randomUUID() }
    const account = JSON.stringify([API_BASE_URL, owner.userId, owner.orgId])
    await set([account, thread, 'pending'], receipt, createStore('okou-g2-device', 'chat'))
    const store = new DeviceStore(owner)
    expect(await store.pending(thread)).toEqual({ clientEventId: receipt.clientEventId, fileIds: [receipt.fileId] })
    await store.acknowledge(thread, receipt.clientEventId)
    expect(await store.pending(thread)).toBeUndefined()
  })

  it('retries the exact send after a lost response and reconciles the promoted input on reopening', async () => {
    const owner = identity(), file = crypto.randomUUID()
    const uploadUrl = 'https://user-artifact-private-prod.98b0b14cee451004596479a689d2071b.r2.cloudflarestorage.com/clip'
    let thread = '', uploads = 0, rows: ChatEventRow[] = []
    const sends: Record<string, unknown>[] = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      if (url === uploadUrl) {
        uploads++
        expect(init.method).toBe('PUT')
        expect(init.credentials).toBe('omit')
        expect(init.headers).toEqual({ 'content-type': 'audio/wav', 'x-amz-meta-artifact-id': file })
        return new Response(null, { status: 200 })
      }
      const call = tool(url, init)
      switch (call.name) {
        case 'create_chat_thread':
          thread = String(call.arguments.clientThreadId)
          return toolResult(init, { threadId: thread })
        case 'get_chat_messages':
          return page(init, rows.filter(r => r.seqId > Number(call.arguments.sinceSeqId ?? 0)), rows.at(-1))
        case 'prepare_voice_upload':
          expect(call.arguments).toEqual({ filename: 'recording.wav', size: 48 })
          return toolResult(init, { id: file, uploadUrl, uploadHeaders: { 'x-amz-meta-artifact-id': file } })
        case 'complete_voice_upload':
          expect(call.arguments).toEqual({ id: file })
          return toolResult(init, { id: file })
        case 'send_chat_message':
          sends.push(call.arguments)
          throw new TypeError('Lost response')
        default: throw new Error('Unexpected tool ' + call.name)
      }
    })
    let state: ChatState = initialChat
    const open = () => new DeviceChat(owner, async () => 'fixture', (s) => { state = s })
    let chat = open()
    try {
      await chat.start()
      const wav = new RecordedVoice()
      await wav.finish(new ArrayBuffer(4))
      await expect(chat.sendVoice(thread, wav)).resolves.toBe('pending')
      await chat.refresh(); chat.close(); chat = open(); await chat.start()
      expect(state.pending).toBe(true)
      expect(sends).toHaveLength(1)
      expect(sends[0]).toEqual({ threadId: thread, clientEventId: expect.any(String),
        userMessage: { version: 1, parts: [{ type: 'voice', clips: [{ fileId: file }] }] } })
      await chat.retryPending()
      expect(sends).toEqual([sends[0], sends[0]])
      expect(uploads).toBe(1)
      rows = [row(thread, 2, { eventType: 'input.prompt', revokesEventId: String(sends[0].clientEventId) }),
        row(thread, 3, { payload: { content: 'The reply' } })]
      vi.mocked(watchThread).mock.calls.at(-1)![3]()
      await chat.refresh()
      expect(state.pending).toBe(false)
      expect(state.rows.at(-1)?.payload?.content).toBe('The reply')
      expect(sends).toHaveLength(2)
    } finally { chat.close() }
  })
})
