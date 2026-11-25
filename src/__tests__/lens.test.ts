import { describe, expect, it } from 'vitest'

import { markdownToPlainText } from '../lens/markdown'
import { currentTask, toLensMessages } from '../lens/messages'
import { paginate } from '../lens/screens'
import type { ChatEventRow } from '../types'

function row(overrides: Partial<ChatEventRow> & Pick<ChatEventRow, 'id' | 'seqId'>): ChatEventRow {
  return {
    chatThreadId: 'thread',
    runId: null,
    revokesEventId: null,
    eventType: 'output.message',
    createdAt: '2026-01-01T00:00:00Z',
    payload: null,
    ...overrides,
  }
}

describe('markdownToPlainText', () => {
  it('keeps link text and drops the URL', () => {
    expect(markdownToPlainText('See [the docs](https://example.com) now')).toBe(
      'See the docs now',
    )
  })

  it('keeps literal code and enough pages to read the entire reply', () => {
    const code = 'const value = "a_b_c <tag> **";'
    expect(markdownToPlainText(['# Result', '```js', code, '```'].join('\n'))).toBe('Result\n' + code)
    const text = '分页读完这条消息🌙'.repeat(200) + 'DONE'
    const pages = paginate(text)
    expect(pages.length).toBeGreaterThan(1)
    expect(pages.join('').replaceAll('\n', '')).toBe(text)
  })
})

describe('toLensMessages', () => {
  it('labels a voice input without displaying the wire prompt', () => {
    const messages = toLensMessages([row({ id: 'voice', seqId: 1, eventType: 'input.prompt',
      payload: { content: '(see message parts)', userMessage: { version: 1, parts: [{ type: 'voice', clips: [{ fileId: 'clip' }] }] } } })])
    expect(messages[0]?.text).toBe('Voice message')
  })

  it('preserves the user turn for an attachment-only message and replaces a rejected input with its error', () => {
    const prompt = row({ id: 'file', seqId: 1, eventType: 'input.prompt',
      payload: { userMessage: { parts: [{ type: 'file', fileId: 'fixture' }] } } })
    expect(toLensMessages([prompt]).at(-1)?.role).toBe('user')
    const denied = row({ id: 'rejected', seqId: 2, revokesEventId: 'file', eventType: 'input.rejected',
      payload: { error: 'Upload unavailable' } })
    expect(toLensMessages([prompt, denied])).toEqual([{ id: 'rejected', seqId: 2, role: 'assistant', text: 'Upload unavailable' }])
  })

  it('keeps user and assistant text in sequence order', () => {
    const messages = toLensMessages([
      row({
        id: 'b',
        seqId: 2,
        eventType: 'output.message',
        payload: { content: '**Hi** there' },
      }),
      row({
        id: 'a',
        seqId: 1,
        eventType: 'input.prompt',
        payload: { userMessage: { version: 1, parts: [{ type: 'text', text: 'Hello' }] } },
      }),
    ])

    expect(messages).toEqual([
      { id: 'a', role: 'user', text: 'Hello', seqId: 1 },
      { id: 'b', role: 'assistant', text: 'Hi there', seqId: 2 },
    ])
  })

  it('reflects a confirmed interrupt once even if its lifecycle cancellation arrives later', () => {
    const rows = [row({ id: 'i', seqId: 1, eventType: 'control.interrupt', runId: 'target' }),
      row({ id: 'c', seqId: 2, eventType: 'run.cancelled', runId: 'target' })]
    expect(toLensMessages(rows)).toEqual([{ id: 'i', seqId: 1, role: 'assistant', text: 'Run cancelled' }])
  })

  it('drops an event that a later event revoked', () => {
    const messages = toLensMessages([
      row({
        id: 'old',
        seqId: 1,
        eventType: 'input.prompt',
        payload: { userMessage: { version: 1, parts: [{ type: 'text', text: 'typo' }] } },
      }),
      row({
        id: 'new',
        seqId: 2,
        eventType: 'input.prompt',
        revokesEventId: 'old',
        payload: { userMessage: { version: 1, parts: [{ type: 'text', text: 'fixed' }] } },
      }),
    ])

    expect(messages.map((message) => message.text)).toEqual(['fixed'])
  })

  it('ignores events that carry no readable text', () => {
    expect(toLensMessages([row({ id: 'u', seqId: 1, eventType: 'usage.recorded' })])).toEqual([])
  })

  it('shows the error for a failed run instead of leaving an empty conversation', () => {
    const messages = toLensMessages([row({ id: 'failed', seqId: 1, eventType: 'run.failed', runId: 'run-1', payload: { error: 'Model is unavailable' } })])
    expect(messages[0]).toMatchObject({ role: 'assistant', text: 'Model is unavailable' })
  })
})

describe('currentTask', () => {
  it('targets a direct run or the active run ahead of queued input', () => {
    const run = row({ id: 'r', seqId: 1, runId: 'run-1', eventType: 'input.prompt' })
    const queued = row({ id: 'q', seqId: 2, eventType: 'input.prompt' })
    expect(currentTask([run, queued])).toEqual({ kind: 'run', id: 'run-1' })
    const finished = row({ id: 'c', seqId: 3, runId: 'run-1', eventType: 'run.completed' })
    expect(currentTask([run, queued, finished])).toEqual({ kind: 'event', id: 'q' })
    expect(currentTask([run, queued, finished, row({ id: 'revoke', seqId: 4, eventType: 'control.revoke', revokesEventId: 'q' })])).toBeNull()
  })

  it('tracks a promoted input and clears it on completion despite trailing activity', () => {
    const queued = row({ id: 'q', seqId: 1, eventType: 'input.prompt' })
    const promoted = row({ id: 'p', seqId: 2, eventType: 'input.prompt', runId: 'run-2', revokesEventId: 'q' })
    expect(currentTask([queued, promoted])).toEqual({ kind: 'run', id: 'run-2' })
    expect(currentTask([queued, promoted,
      row({ id: 'c', seqId: 3, eventType: 'run.cancelled', runId: 'run-2' }),
      row({ id: 'u', seqId: 4, eventType: 'usage.recorded', runId: 'run-2' }),
    ])).toBeNull()
  })
})
