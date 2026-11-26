import type { ChatEventRow } from '../types'
import { markdownToPlainText } from './markdown'

export interface LensReply {
  readonly id: string
  readonly seqId: number
  readonly text: string
}

export type TaskTarget = { kind: 'run' | 'event'; id: string }
export type ChatFact = Pick<ChatEventRow, 'id' | 'seqId' | 'eventType' | 'runId' | 'revokesEventId' | 'createdAt'>

// The Web event contract permits recalls and replacements of inputs.
// output.message is immutable, so the lens only needs its newest nonempty text.
export function assistantReply(row: ChatEventRow): LensReply | null {
  if (row.eventType !== 'output.message' || typeof row.payload?.content !== 'string') return null
  const text = markdownToPlainText(row.payload.content)
  return text ? { id: row.id, seqId: row.seqId, text } : null
}

const terminal = (type: string) => type === 'run.completed' || type === 'run.failed' || type === 'run.cancelled'
const input = (type: string) => type === 'input.prompt' || type === 'input.automation'

function queueOrder(left: ChatFact, right: ChatFact) {
  if (left.eventType !== right.eventType) return left.eventType === 'input.prompt' ? -1 : 1
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1
  return left.id.localeCompare(right.id)
}

// A thread has at most one active run. As in Platform's chat-run-state, a
// standalone assistant output can end the indicator while the run still exists.
export function taskState(facts: readonly ChatFact[]) {
  const revoked = new Set<string>(), ended = new Set<string>()
  for (const { revokesEventId, eventType, runId } of facts) {
    if (revokesEventId) revoked.add(revokesEventId)
    if (runId && (terminal(eventType) || eventType === 'control.interrupt')) ended.add(runId)
  }

  let queued: ChatFact | undefined
  let activeRun: string | null = null, working = false
  for (const row of facts) {
    const { eventType, runId } = row
    if (revoked.has(row.id) || eventType === 'usage.recorded') continue
    if (!runId && input(eventType) && (!queued || queueOrder(row, queued) < 0)) queued = row

    if (terminal(eventType) || eventType === 'control.interrupt' ||
        (!runId && (eventType === 'output.message' || eventType === 'output.error'))) {
      working = false
    } else if (runId && !ended.has(runId)) {
      activeRun = runId
      working = true
    }
  }
  const task: TaskTarget | null = activeRun ? { kind: 'run', id: activeRun } : queued ? { kind: 'event', id: queued.id } : null
  return { task, working: working || !!queued }
}
