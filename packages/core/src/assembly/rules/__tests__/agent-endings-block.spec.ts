import { describe, expect, it } from 'bun:test'

import { EAgentStart } from '../../../agents/start'
import { EAgentStatus } from '../../../agents/status'
import type { EventDraft } from '../../../events/body'
import { toThreadId } from '../../../events/ids'
import { contextFor, fixtureThreadId, log } from '../../__tests__/log-fixture'
import { agentEndingsBlock } from '../agent-endings-block'
import { messagesFromEvents } from '../messages-from-events'

const CHILD = toThreadId('thread-child-1')

const spawned = (
  over: Partial<Extract<EventDraft, { type: 'agent-spawned' }>> = {},
): EventDraft => ({
  type: 'agent-spawned',
  agentId: CHILD,
  agentType: 'explore',
  intent: 'audit the settings registry',
  mode: EAgentStart.Fresh,
  ...over,
})

const ended = (over: Partial<Extract<EventDraft, { type: 'agent-ended' }>> = {}): EventDraft => ({
  type: 'agent-ended',
  agentId: CHILD,
  agentType: 'explore',
  intent: 'audit the settings registry',
  status: EAgentStatus.Finished,
  prose: 'The registry has 14 settings; two are unread.',
  turns: 4,
  toolCalls: 11,
  ...over,
})

const assembleWith = ({
  drafts,
  proseBudget,
}: {
  drafts: readonly EventDraft[]
  proseBudget?: number
}) => {
  const events = log(drafts)
  const ctx = contextFor({ events })
  const withMessages = messagesFromEvents()({ system: [], messages: [] }, ctx)
  const rule = proseBudget === undefined ? agentEndingsBlock() : agentEndingsBlock({ proseBudget })
  return rule(withMessages, ctx)
}

const textsOf = (assembled: ReturnType<typeof assembleWith>): string[] =>
  assembled.messages.flatMap((entry) =>
    entry.message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])),
  )

const blocksOf = (assembled: ReturnType<typeof assembleWith>): string[] =>
  textsOf(assembled).filter((text) => text.startsWith('<agents-ended>'))

describe('handing a finished delegate to the parent that spawned it', () => {
  it('names the delegate, counts its work, and hands over its report', () => {
    const block = blocksOf(assembleWith({ drafts: [spawned(), ended()] }))[0] ?? ''

    expect(block).toContain('thread-child-1')
    expect(block).toContain('explore "audit the settings registry"')
    expect(block).toContain('finished after 4 turns and 11 tool calls')
    expect(block).toContain('The registry has 14 settings; two are unread.')
  })

  it('says a delegate reported nothing rather than leaving a hole', () => {
    const block = blocksOf(assembleWith({ drafts: [ended({ prose: '  \n ' })] }))[0] ?? ''

    expect(block).toContain('It reported nothing.')
  })

  it('renders the ending where it landed in the log, not at the tail', () => {
    const texts = textsOf(
      assembleWith({
        drafts: [{ type: 'user-said', text: 'go' }, ended(), { type: 'user-said', text: 'later' }],
      }),
    )

    expect(texts[0]).toBe('go')
    expect(texts[1]).toStartWith('<agents-ended>')
    expect(texts[2]).toBe('later')
  })

  it('spells out that the delegate steps are not coming', () => {
    const block = blocksOf(assembleWith({ drafts: [ended()] }))[0] ?? ''

    expect(block).toContain('None of their own steps are in your history')
  })
})

describe('a spawned delegate', () => {
  it('renders as nothing at all: the tool result already said it started', () => {
    const assembled = assembleWith({ drafts: [{ type: 'user-said', text: 'go' }, spawned()] })

    expect(textsOf(assembled)).toEqual(['go'])
  })
})

describe('the parent log keeps counts, never the child transcript', () => {
  it('holds no event belonging to the child thread', () => {
    const events = log([spawned(), ended()])

    expect(events.every((event) => event.threadId === fixtureThreadId)).toBe(true)
    expect(events.some((event) => event.threadId === CHILD)).toBe(false)
    expect(events.map((event) => event.type)).toEqual(['agent-spawned', 'agent-ended'])
  })
})

const wave = (size: number): EventDraft[] =>
  Array.from({ length: size }, (_unused, index) =>
    ended({
      agentId: toThreadId(`thread-child-${index + 1}`),
      intent: `slice ${index + 1}`,
      prose: `report ${index + 1} `.padEnd(2_000, 'x'),
    }),
  )

describe('twenty delegates finishing at once', () => {
  it('collapses the wave into one block instead of twenty', () => {
    const assembled = assembleWith({ drafts: wave(20) })

    expect(blocksOf(assembled)).toHaveLength(1)
  })

  it('keeps the whole wave inside the prose budget', () => {
    const block = blocksOf(assembleWith({ drafts: wave(20) }))[0] ?? ''

    expect(block.length).toBeLessThan(13_000)
  })

  it('counts every delegate even though it can quote none of them whole', () => {
    const block = blocksOf(assembleWith({ drafts: wave(20) }))[0] ?? ''

    expect(block).toContain('20 agents you spawned ended')

    for (let index = 1; index <= 20; index += 1) {
      expect(block).toContain(`thread-child-${index} `)
      expect(block).toContain(`"slice ${index}"`)
      expect(block).toContain(`report ${index} `)
    }
  })

  it('says how much of each report it dropped rather than trimming silently', () => {
    const block = blocksOf(assembleWith({ drafts: wave(20) }))[0] ?? ''

    expect(block).toContain('[1600 characters of this report were dropped')
  })

  it('leaves a lone ending untouched at the same budget', () => {
    const block = blocksOf(assembleWith({ drafts: wave(1) }))[0] ?? ''

    expect(block).not.toContain('were dropped')
    expect(block.length).toBeGreaterThan(2_000)
  })
})

describe('sharing the budget between a short report and a long one', () => {
  it('gives the long report the space the short one did not need', () => {
    const block =
      blocksOf(
        assembleWith({
          proseBudget: 1_000,
          drafts: [
            ended({ agentId: toThreadId('thread-child-1'), prose: 'a'.repeat(100) }),
            ended({ agentId: toThreadId('thread-child-2'), prose: 'b'.repeat(5_000) }),
          ],
        }),
      )[0] ?? ''

    expect(block).toContain('a'.repeat(100))
    expect(block).toContain('[4100 characters of this report were dropped')
  })
})

describe('two waves separated by the parent working', () => {
  it('renders each wave where it landed', () => {
    const texts = textsOf(
      assembleWith({
        drafts: [
          ended({ agentId: toThreadId('thread-child-1'), prose: 'first wave' }),
          { type: 'user-said', text: 'carry on' },
          ended({ agentId: toThreadId('thread-child-2'), prose: 'second wave' }),
        ],
      }),
    )

    expect(texts).toHaveLength(3)
    expect(texts[0]).toContain('first wave')
    expect(texts[1]).toBe('carry on')
    expect(texts[2]).toContain('second wave')
  })

  it('counts each wave on its own', () => {
    const blocks = blocksOf(
      assembleWith({
        drafts: [
          ended({ agentId: toThreadId('thread-child-1') }),
          ended({ agentId: toThreadId('thread-child-2') }),
          { type: 'user-said', text: 'carry on' },
          ended({ agentId: toThreadId('thread-child-3') }),
        ],
      }),
    )

    expect(blocks[0]).toContain('2 agents you spawned ended')
    expect(blocks[1]).toContain('1 agent you spawned ended')
  })
})
