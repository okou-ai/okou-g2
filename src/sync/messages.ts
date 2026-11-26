import { ApiError, type OkouApiClient } from '../api/client'
import { assistantReply, taskState, type ChatFact, type LensReply, type TaskTarget } from '../lens/messages'
import { isUuid, type ChatEventCursor, type ChatEventRow } from '../types'

export interface History {
  facts: readonly ChatFact[]
  cursor: ChatEventCursor
  reply: LensReply | null
  task: TaskTarget | null
  working: boolean
}

type Snapshot = ChatEventCursor & { url: string }
type McpRow = Omit<ChatEventRow, 'id' | 'chatThreadId'> & { eventId: string; threadId: string }
type Page = { snapshot: Snapshot | null; rows: McpRow[]; cursor: ChatEventCursor; hasMore: boolean }

function messages(client: OkouApiClient, threadId: string, cursor?: ChatEventCursor) {
  return client.call<Page>('get_chat_messages', { threadId, limit: 50,
    sinceSeqId: cursor?.lastSeqId, sinceEventId: cursor?.lastEventId ?? undefined })
}
const START: ChatEventCursor = { lastSeqId: 0, lastEventId: null }
class SnapshotUnavailable extends Error {}

async function readArchive(response: Response, consume: (row: ChatEventRow) => void) {
  if (!response.body) throw new Error('Missing chat archive')
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  let rest = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const lines = (rest + value).split('\n')
      rest = lines.pop()!
      for (const line of lines) consume(JSON.parse(line))
    }
    if (rest) throw new Error('Incomplete chat archive')
  } finally {
    await reader.cancel()
  }
}

// Every row advances the paired cursor, including rows with no lens content.
async function readRange(client: OkouApiClient, thread: string, from: ChatEventCursor | undefined,
    consume: (row: ChatEventRow) => void): Promise<ChatEventCursor> {
  let cursor = from ?? START
  const append = (row: ChatEventRow) => {
    if (row?.chatThreadId !== thread || !isUuid(row.id) || !Number.isSafeInteger(row.seqId) ||
        row.seqId <= cursor.lastSeqId || typeof row.eventType !== 'string') throw new Error('Invalid chat history row')
    consume(row)
    cursor = { lastSeqId: row.seqId, lastEventId: row.id }
  }
  const verify = (expected: ChatEventCursor) => {
    if (expected.lastEventId !== cursor.lastEventId || expected.lastSeqId !== cursor.lastSeqId) {
      throw new Error('Incomplete chat history cursor')
    }
  }
  let tail = await messages(client, thread, from)
  if (!from && tail.snapshot) {
    const url = new URL(tail.snapshot.url)
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid chat archive URL')
    const archive = await fetch(url, { credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal: client.signal }).catch(() => {
      client.signal.throwIfAborted()
      return null
    })
    if (!archive?.ok) {
      const detail = archive ? 'HTTP ' + archive.status : 'network or cross-origin access'
      throw new SnapshotUnavailable('Could not download the chat history snapshot (' + detail + ')')
    }
    await readArchive(archive, append)
    verify(tail.snapshot)
  }
  for (;;) {
    if (!Array.isArray(tail.rows) || typeof tail.hasMore !== 'boolean' ||
        (tail.hasMore && !tail.rows.length)) throw new Error('Invalid chat history page')
    for (const { eventId, threadId, ...row } of tail.rows) append({ ...row, id: eventId, chatThreadId: threadId })
    verify(tail.cursor)
    if (!tail.hasMore) return cursor
    tail = await messages(client, thread, cursor)
  }
}

export async function readHistory(client: OkouApiClient, thread: string, previous: History | null): Promise<History> {
  for (let attempt = 0; ; attempt++) {
    const cached = attempt === 0 ? previous : null
    const incoming: { facts: ChatFact[]; reply: LensReply | null } = { facts: [], reply: null }
    try {
      const cursor = await readRange(client, thread, cached?.cursor, row => {
        const { id, seqId, eventType, runId, revokesEventId, createdAt } = row
        if (eventType === 'usage.recorded' && !revokesEventId) return
        const reply = assistantReply(row)
        if (reply) incoming.reply = reply
        incoming.facts.push({ id, seqId, eventType, runId, revokesEventId, createdAt })
      })
      if (cached && cached.cursor.lastEventId === cursor.lastEventId) return cached
      if (cached && !incoming.facts.length) return { ...cached, cursor }
      const facts = cached ? cached.facts.concat(incoming.facts) : incoming.facts
      return { facts, cursor, reply: incoming.reply ?? cached?.reply ?? null, ...taskState(facts) }
    } catch (error) {
      const expired = error instanceof ApiError && (error.status === 410 || error.code === 'CHAT_EVENTS_EXPIRED')
      if (attempt !== 0 || !(expired || error instanceof SnapshotUnavailable)) throw error
    }
  }
}
