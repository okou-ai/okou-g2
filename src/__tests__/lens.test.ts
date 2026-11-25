import { describe, expect, it } from 'vitest'

import { markdownToPlainText } from '../lens/markdown'
import { isRunInProgress, toLensMessages } from '../lens/messages'
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

describe('isRunInProgress', () => {
  it('shows thinking for a direct send that has a run but never entered the queue', () => {
    expect(isRunInProgress([row({ id: 'input', seqId: 1, runId: 'run-1', eventType: 'input.prompt' })])).toBe(true)
  })

  it('is true while a run has started but not finished', () => {
    expect(
      isRunInProgress([row({ id: 'q', seqId: 1, runId: 'run-1', eventType: 'run.queued' })]),
    ).toBe(true)
  })

  it('is false once the run reaches a terminal event', () => {
    expect(
      isRunInProgress([
        row({ id: 'q', seqId: 1, runId: 'run-1', eventType: 'run.queued' }),
        row({ id: 'c', seqId: 2, runId: 'run-1', eventType: 'run.completed' }),
      ]),
    ).toBe(false)
  })

  it('stays false when trailing events are appended after completion', () => {
    expect(
      isRunInProgress([
        row({ id: 'q', seqId: 1, runId: 'run-1', eventType: 'run.queued' }),
        row({ id: 'c', seqId: 2, runId: 'run-1', eventType: 'run.completed' }),
        row({ id: 'u', seqId: 3, runId: 'run-1', eventType: 'usage.recorded' }),
      ]),
    ).toBe(false)
  })

  it('tracks the newest run, not an older finished one', () => {
    expect(
      isRunInProgress([
        row({ id: 'a', seqId: 1, runId: 'run-1', eventType: 'run.queued' }),
        row({ id: 'b', seqId: 2, runId: 'run-1', eventType: 'run.completed' }),
        row({ id: 'c', seqId: 3, runId: 'run-2', eventType: 'run.queued' }),
      ]),
    ).toBe(true)
  })
})
