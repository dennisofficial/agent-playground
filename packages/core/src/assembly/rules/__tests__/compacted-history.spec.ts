import { describe, expect, it } from 'bun:test'

import { ECompactionAnchor } from '../../../events/body'
import {
  compactedRange,
  eventsFrom,
  loaded,
  replied,
  said,
} from '../../../compaction/__tests__/fixture'
import type { Event } from '../../../events/envelope'
import { toThreadId } from '../../../events/ids'
import { assemble } from '../../assemble'
import type { RuleContext } from '../../rule'
import { estimateTokens } from '../../tokens'
import { compactedHistory } from '../compacted-history'
import { messagesFromEvents } from '../messages-from-events'

const contextOf = (events: readonly Event[]): RuleContext => ({
  events,
  threadId: toThreadId('thread-1'),
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
    text: entry.message.content.map((part) => ('text' in part ? part.text : part.type)).join(' '),
  }))

describe('compactedHistory', () => {
  it('leaves a thread that was never compacted exactly as the content rules built it', () => {
    const events = eventsFrom([said('hello'), replied('hi'), said('again')])

    expect(promptOf(events)).toEqual([
      { role: 'user', text: 'hello' },
      { role: 'assistant', text: 'hi' },
      { role: 'user', text: 'again' },
    ])
  })

  it('drops the turns the watermark covers, even though the log still holds them', () => {
    const events = eventsFrom([
      said('build the parser'),
      replied('done'),
      compactedRange({ fromSeq: 1, throughSeq: 2, summary: 'A parser was written.' }),
      said('now the formatter'),
    ])

    expect(promptOf(events)).toEqual([
      {
        role: 'user',
        text: '<system-reminder>\nEarlier turns of this conversation, compacted to save context:\n\nA parser was written.\n</system-reminder>',
      },
      { role: 'user', text: 'now the formatter' },
    ])
  })

  it('keeps loaded context, because it is current content rather than history', () => {
    const events = eventsFrom([
      loaded('project-instructions', '/repo/CLAUDE.md', 'Never use as any.'),
      said('build the parser'),
      compactedRange({ fromSeq: 1, throughSeq: 2, summary: 'A parser was written.' }),
      said('now the lexer'),
    ])

    const prompt = promptOf(events)

    expect(prompt).toHaveLength(3)
    expect(prompt[0]?.text).toContain('Never use as any.')
    expect(prompt[1]?.text).toContain('A parser was written.')
    expect(prompt[2]).toEqual({ role: 'user', text: 'now the lexer' })
  })

  it('renders a prefix and a suffix summary each at its own position', () => {
    const events = eventsFrom([
      said('one'),
      replied('two'),
      compactedRange({ fromSeq: 1, throughSeq: 2, summary: 'the opening exchange' }),
      said('the middle'),
      replied('four'),
      compactedRange({
        fromSeq: 5,
        throughSeq: 5,
        summary: 'everything after the middle',
        anchor: ECompactionAnchor.Suffix,
      }),
    ])

    expect(promptOf(events).map((entry) => entry.text)).toEqual([
      expect.stringContaining('the opening exchange'),
      'the middle',
      expect.stringContaining('everything after the middle'),
    ])
  })

  it('still renders the summary when the rows it covered were deleted', () => {
    const events = eventsFrom([
      compactedRange({ fromSeq: 1, throughSeq: 1, summary: 'everything before' }),
      said('what survived'),
    ])

    expect(promptOf(events).map((entry) => entry.text)).toEqual([
      expect.stringContaining('everything before'),
      'what survived',
    ])
  })
})
