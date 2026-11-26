import { describe, expect, it } from 'vitest'

import { markdownToPlainText } from '../lens/markdown'
import { taskState, type ChatFact } from '../lens/messages'
import { paginate } from '../lens/screens'

function fact(seqId: number, eventType: string, runId: string | null = null, revokesEventId: string | null = null): ChatFact {
  return { id: String(seqId), seqId, eventType, runId, revokesEventId, createdAt: String(seqId) }
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

describe('taskState', () => {
  it('follows one queued input through replacement, claim and cancellation', () => {
    const answer = fact(1, 'output.message')
    const queue = fact(2, 'input.prompt')
    const replacement = fact(3, 'input.prompt', null, queue.id)
    const claimed = fact(4, 'input.prompt', 'run', replacement.id)
    const history = [answer, queue, replacement]
    expect(taskState(history)).toEqual({ task: { kind: 'event', id: replacement.id }, working: true })
    expect(taskState([...history, fact(4, 'control.revoke', null, replacement.id)]))
      .toEqual({ task: null, working: false })
    history.push(claimed)
    expect(taskState(history)).toEqual({ task: { kind: 'run', id: 'run' }, working: true })
    history.push(fact(5, 'control.interrupt', 'run'), fact(6, 'run.cancelled', 'run'))
    expect(taskState(history)).toEqual({ task: null, working: false })
  })

  it('moves from one completed run to the next and stays idle after usage arrives', () => {
    const first = fact(2, 'output.message', 'first')
    const history = [fact(1, 'input.prompt', 'first'), first, fact(3, 'run.completed', 'first')]
    expect(taskState(history)).toEqual({ task: null, working: false })
    history.push(fact(4, 'input.prompt', 'next'))
    expect(taskState(history)).toEqual({ task: { kind: 'run', id: 'next' }, working: true })
    const answer = fact(5, 'output.message', 'next')
    history.push(answer, fact(6, 'run.failed', 'next'), fact(7, 'usage.recorded', 'next'))
    expect(taskState(history)).toEqual({ task: null, working: false })
  })

  it('handles a standalone output ending the visible indicator independently of the live run and queue', () => {
    const history = [fact(1, 'input.prompt', 'old'), fact(2, 'output.message', 'old'), fact(3, 'output.error')]
    expect(taskState(history)).toEqual({ task: { kind: 'run', id: 'old' }, working: false })
    const next = fact(4, 'output.message', 'old')
    history.push(next)
    expect(taskState(history)).toEqual({ task: { kind: 'run', id: 'old' }, working: true })
    history.push(fact(5, 'input.prompt'), fact(6, 'run.completed', 'old'))
    expect(taskState(history)).toEqual({ task: { kind: 'event', id: '5' }, working: true })
    history.push(fact(7, 'input.rejected', null, '5'))
    expect(taskState(history)).toEqual({ task: null, working: false })
  })
})
