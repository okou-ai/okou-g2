import { ApiError, type OkouApiClient } from '../api/client'
import { isUuid, type ChatEventCursor, type ChatEventRow } from '../types'

export interface History {
  rows: ChatEventRow[]
  cursor: ChatEventCursor
}

type Snapshot = ChatEventCursor & { url: string }
type McpRow = Omit<ChatEventRow, 'id' | 'chatThreadId'> & { eventId: string; threadId: string }
type Page = { snapshot: Snapshot | null; rows: McpRow[]; cursor: ChatEventCursor; hasMore: boolean }

function messages(client: OkouApiClient, threadId: string, cursor?: ChatEventCursor) {
  return client.call<Page>('get_chat_messages', { threadId, limit: 50,
    sinceSeqId: cursor?.lastSeqId, sinceEventId: cursor?.lastEventId ?? undefined })
}
const START: ChatEventCursor = { lastSeqId: 0, lastEventId: null }
const KEEP = new Set(['input.prompt', 'input.automation', 'input.rejected', 'input.budget', 'input.goal',
  'output.message', 'output.error', 'control.interrupt', 'run.queued', 'run.dequeued', 'run.completed', 'run.failed', 'run.cancelled'])

async function readArchive(response: Response, consume: (row: ChatEventRow) => void) {
  if (!response.body) throw new Error('Missing chat archive')
  // A long-running device thread can have years of history. Retain one
  // incomplete NDJSON line and the presentation window, not the entire file.
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

export async function readHistory(
  client: OkouApiClient, thread: string, previous: History | null, pendingId?: string,
): Promise<History & { acknowledged: boolean }> {
  const matches = (r: ChatEventRow) => !!pendingId && r.eventType === 'input.prompt' &&
    (r.id === pendingId || r.revokesEventId === pendingId)
  for (let attempt = 0; attempt < 2; attempt++) {
    const cached = attempt === 0 ? previous : null
    const rows = cached?.rows.slice() ?? []
    let cursor = cached?.cursor ?? START
    let acknowledged = rows.some(matches)
    const append = (row: ChatEventRow) => {
      if (row?.chatThreadId !== thread || !isUuid(row.id) || !Number.isSafeInteger(row.seqId) ||
          row.seqId <= cursor.lastSeqId || typeof row.eventType !== 'string') throw new Error('Invalid chat history row')
      if (matches(row)) acknowledged = true
      if (KEEP.has(row.eventType) || row.revokesEventId) {
        rows.push(row)
        if (rows.length > 200) rows.shift()
      }
      cursor = { lastSeqId: row.seqId, lastEventId: row.id }
    }
    const verify = (expected: ChatEventCursor) => {
      if (expected.lastEventId !== cursor.lastEventId || expected.lastSeqId !== cursor.lastSeqId) {
        throw new Error('Incomplete chat history cursor')
      }
    }

    try {
      let tail = await messages(client, thread, cached?.cursor)
      const snapshot = tail.snapshot
      if (!cached && snapshot) {
        const url = new URL(snapshot.url)
        if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid chat archive URL')
        const archive = await fetch(url, { credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal: client.signal }).catch(() => {
          client.signal.throwIfAborted()
          return null
        })
        if (archive?.ok) {
          await readArchive(archive, append)
          verify(snapshot)
        } else {
          // Compacted threads reject a zero cursor. Renew a possibly stale
          // signed URL once, then surface the actual download failure.
          if (attempt === 0) continue
          const detail = archive ? 'HTTP ' + archive.status : 'network or cross-origin access'
          throw new Error('Could not download the chat history snapshot (' + detail + ')')
        }
      }
      for (;;) {
        if (!Array.isArray(tail.rows) || typeof tail.hasMore !== 'boolean' ||
            (tail.hasMore && !tail.rows.length)) throw new Error('Invalid chat history page')
        for (const { eventId, threadId, ...row } of tail.rows) append({ ...row, id: eventId, chatThreadId: threadId })
        verify(tail.cursor)
        if (!tail.hasMore) return {
          rows: cached && cursor.lastEventId === cached.cursor.lastEventId ? cached.rows : rows,
          cursor, acknowledged,
        }
        tail = await messages(client, thread, cursor)
      }
    } catch (error) {
      const expired = error instanceof ApiError && (error.status === 410 || error.code === 'CHAT_EVENTS_EXPIRED')
      if (attempt !== 0 || !expired) throw error
    }
  }
  throw new Error('Chat history cursor expired')
}
