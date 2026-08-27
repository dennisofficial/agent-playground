import { describe, expect, it } from 'bun:test'

import { compacted, eventsFrom, loaded, replied, said } from '../../../compaction/__tests__/fixture'
import type { Event } from '../../../events/envelope'
import { toBranchId } from '../../../events/ids'
import { assemble } from '../../assemble'
import type { RuleContext } from '../../rule'
import { estimateTokens } from '../../tokens'
import { compactedHistory } from '../compacted-history'
import { messagesFromEvents } from '../messages-from-events'

const contextOf = (events: readonly Event[]): RuleContext => ({
  events,
  branchId: toBranchId('branch-1'),
  step: 0,
  provider: { id: 'anthropic', modelId: 'claude-opus-5' },
  countTokens: estimateTokens,
})

const promptOf = (events: readonly Event[]) =>
  assemble({
    rules: [messagesFromEvents(), compactedHistory()],
    ctx: contextOf(events),
  }).assembled.messages.map((entry) => ({
    role: entry.message.role,
    text: entry.message.content
      .map((part) => ('text' in part ? part.text : part.type))
      .join(' '),
  }))

describe('compactedHistory', () => {
  it('leaves a branch that was never compacted exactly as the content rules built it', () => {
    const events = eventsFrom([said('hello'), replied('hi'), said('again')])

    expect(promptOf(events)).toEqual([
      { role: 'user', text: 'hello' },
      { role: 'assistant', text: 'hi' },
      { role: 'user', text: 'again' },
    ])
  })

  it('renders the summary ahead of the turns the branch still holds', () => {
    const events = eventsFrom([
      compacted(4, 'The operator asked for a parser and a lexer; both are written.'),
      said('now the formatter'),
    ])

    expect(promptOf(events)).toEqual([
      {
        role: 'user',
        text: '<system-reminder>\nEarlier turns of this conversation, compacted to save context:\n\nThe operator asked for a parser and a lexer; both are written.\n</system-reminder>',
      },
      { role: 'user', text: 'now the formatter' },
    ])
  })

  it('renders nothing but the summary on a branch compacted all the way to its head', () => {
    const events = eventsFrom([compacted(6, 'Everything so far.')])

    const prompt = promptOf(events)

    expect(prompt).toHaveLength(1)
    expect(prompt[0]?.text).toContain('Everything so far.')
  })

  it('puts loaded context ahead of the summary, because compaction spares it', () => {
    const events = eventsFrom([
      loaded('project-instructions', '/repo/CLAUDE.md', 'Never use as any.'),
      compacted(3, 'A parser was written.'),
      said('now the lexer'),
    ])

    const prompt = promptOf(events)

    expect(prompt[0]?.text).toContain('Never use as any.')
    expect(prompt[1]?.text).toContain('A parser was written.')
    expect(prompt[2]).toEqual({ role: 'user', text: 'now the lexer' })
  })

  it('honours the deepest watermark when a branch carries more than one', () => {
    const events = eventsFrom([
      compacted(2, 'the first exchange'),
      compacted(5, 'both exchanges'),
      said('third'),
    ])

    const prompt = promptOf(events)

    expect(prompt[0]?.text).toContain('both exchanges')
    expect(prompt.some((entry) => entry.text.includes('the first exchange'))).toBe(false)
  })
})
