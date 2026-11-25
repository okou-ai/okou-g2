/**
 * Projects raw chat event rows into what the lens shows.
 *
 * The rows are the same append-only events the platform renders, so the
 * projection has to decide which of them are worth a line on a 576×288 display
 * and whether a run is still working.
 */
import { markdownToPlainText } from './markdown'
import type { ChatEventRow } from '../types'

export type LensRole = 'user' | 'assistant'

export interface LensMessage {
  readonly id: string
  readonly role: LensRole
  readonly text: string
  readonly seqId: number
}

/** Event types that carry text a person actually wants to read. */
const USER_TYPES = new Set(['input.prompt', 'input.automation', 'input.budget', 'input.goal'])
const ASSISTANT_TYPES = new Set(['output.message', 'output.error', 'input.rejected', 'run.failed', 'run.cancelled', 'control.interrupt'])

/** A run is working between these and its terminal event. */
const RUN_ACTIVITY = new Set([...USER_TYPES, 'run.queued', 'run.dequeued', 'output.message'])
const RUN_FINISHED = new Set(['run.completed', 'run.failed', 'run.cancelled', 'control.interrupt'])

/**
 * Pull readable text out of a row.
 *
 * `input.prompt` rows carry a structured `userMessage` document; assistant rows
 * carry `content`. Both are reduced to plain text because the lens cannot
 * render Markdown.
 */
function rowText(row: ChatEventRow): string | null {
  const payload = row.payload
  if (row.eventType === 'input.rejected') return markdownToPlainText(payload?.error ?? 'Message rejected')
  if (row.eventType === 'run.cancelled' || row.eventType === 'control.interrupt') return 'Run cancelled'
  if (row.eventType === 'output.error' || row.eventType === 'run.failed') {
    return markdownToPlainText(payload?.error ?? payload?.content ?? 'Run failed')
  }
  if (!payload) return null

  if (USER_TYPES.has(row.eventType)) {
    const doc = payload.userMessage as { parts?: { type?: string; text?: string }[] } | undefined
    if (Array.isArray(doc?.parts)) {
      const parts = doc.parts.flatMap((part) => {
        if (part.type === 'voice') return ['Voice message']
        return part.type === 'text' && typeof part.text === 'string' ? [part.text] : []
      })
      return parts.join(' ').trim() || (doc.parts.length ? 'Message' : null)
    }
  }
  return typeof payload.content === 'string' ? markdownToPlainText(payload.content) : null
}

/**
 * Oldest first, newest last — the reading order on screen.
 *
 * Revoked events are dropped: an `input.prompt` the user replaced should not
 * linger on the lens next to its replacement.
 */
export function toLensMessages(rows: readonly ChatEventRow[]): readonly LensMessage[] {
  const revoked = new Set(
    rows.map((row) => row.revokesEventId).filter((id): id is string => id !== null),
  )

  // The stored interrupt row carries its target in runId. The server can
  // append a lifecycle cancellation for that same request later.
  const interrupted = new Set(rows.filter(row => row.eventType === 'control.interrupt').map(row => row.runId))
  const messages: LensMessage[] = []
  for (const row of [...rows].sort((left, right) => left.seqId - right.seqId)) {
    if (revoked.has(row.id) || (row.eventType === 'run.cancelled' && interrupted.has(row.runId))) continue
    const role: LensRole | null = USER_TYPES.has(row.eventType)
      ? 'user'
      : ASSISTANT_TYPES.has(row.eventType)
        ? 'assistant'
        : null
    if (!role) continue
    const text = rowText(row)
    if (!text) continue
    messages.push({ id: row.id, role, text, seqId: row.seqId })
  }
  return messages
}

export type TaskTarget = { kind: 'run' | 'event'; id: string }

/** An active run takes priority over inputs waiting behind it. */
export function currentTask(rows: readonly ChatEventRow[]): TaskTarget | null {
  const finished = new Set(rows.filter(row => RUN_FINISHED.has(row.eventType)).map(row => row.runId))
  const run = rows.findLast(row => row.runId && RUN_ACTIVITY.has(row.eventType) && !finished.has(row.runId))
  if (run?.runId) return { kind: 'run', id: run.runId }

  const replaced = new Set(rows.map(row => row.revokesEventId))
  const queued = rows.find(row => !row.runId && USER_TYPES.has(row.eventType) && !replaced.has(row.id))
  return queued ? { kind: 'event', id: queued.id } : null
}
