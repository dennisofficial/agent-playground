import { describe, expect, it } from 'bun:test'

import { EAgentStart } from '../../../agents/start'
import { EAgentStatus } from '../../../agents/status'
import { EKilledBy } from '../../../shells/status'
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

const assembleWith = ({ drafts }: { drafts: readonly EventDraft[] }) => {
  const events = log(drafts)
  const ctx = contextFor({ events })
  const withMessages = messagesFromEvents()({ system: [], messages: [] }, ctx)
  return agentEndingsBlock()(withMessages, ctx)
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

const ORDINARY_REPORT = 20_000

const report = ({ index, characters }: { index: number; characters: number }): string =>
  `report ${index} opens ${'x'.repeat(characters)} report ${index} closes`

const wave = ({
  size,
  characters = ORDINARY_REPORT,
}: {
  size: number
  characters?: number
}): EventDraft[] =>
  Array.from({ length: size }, (_unused, index) =>
    ended({
      agentId: toThreadId(`thread-child-${index + 1}`),
      intent: `slice ${index + 1}`,
      prose: report({ index: index + 1, characters }),
    }),
  )

describe('six delegates finishing at once, the shape of a real fan-out', () => {
  it('collapses the wave into one block instead of six', () => {
    expect(blocksOf(assembleWith({ drafts: wave({ size: 6 }) }))).toHaveLength(1)
  })

  it('hands over all six reports character for character, nothing elided', () => {
    const drafts = wave({ size: 6 })
    const block = blocksOf(assembleWith({ drafts }))[0] ?? ''

    expect(block).toContain('6 agents you spawned ended')

    for (const draft of drafts) {
      if (draft.type !== 'agent-ended') continue
      expect(block).toContain(draft.prose)
    }
  })

  it('never shrinks a report because its siblings ended at the same moment', () => {
    const alone = blocksOf(assembleWith({ drafts: wave({ size: 1 }) }))[0] ?? ''
    const together = blocksOf(assembleWith({ drafts: wave({ size: 6 }) }))[0] ?? ''

    expect(together.length).toBeGreaterThan(6 * ORDINARY_REPORT)
    expect(together.length).toBeGreaterThan(5 * alone.length)
  })

  it('carries a report that would have been trimmed under any ceiling we considered', () => {
    const large = 'b'.repeat(60_000)
    const block = blocksOf(assembleWith({ drafts: [ended({ prose: large })] }))[0] ?? ''

    expect(block).toContain(large)
  })

  it('passes half a million characters through intact, so no ceiling returns unnoticed', () => {
    const enormous = 'c'.repeat(500_000)
    const block = blocksOf(assembleWith({ drafts: [ended({ prose: enormous })] }))[0] ?? ''

    expect(block).toContain(enormous)
  })

  it('leaves twenty ordinary reports intact too, and lets compaction handle the size', () => {
    const block = blocksOf(assembleWith({ drafts: wave({ size: 20 }) }))[0] ?? ''

    expect(block.length).toBeGreaterThan(20 * ORDINARY_REPORT)
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

describe('an agent the operator stopped', () => {
  const stoppedBy = (killedBy: EKilledBy): string =>
    blocksOf(
      assembleWith({
        drafts: [
          spawned(),
          ended({ status: EAgentStatus.Stopped, killedBy, prose: 'I had read four files.' }),
        ],
      }),
    )[0] ?? ''

  it('tells the parent a human did it, so it does not read the stop as its own', () => {
    const block = stoppedBy(EKilledBy.User)

    expect(block).toContain('was stopped by the user after')
    expect(block).toContain('The user stopped this agent deliberately')
    expect(block).toContain('I had read four files.')
  })

  it('says nothing extra when the parent stopped it itself', () => {
    const block = stoppedBy(EKilledBy.Model)

    expect(block).toContain('was stopped at your request after')
    expect(block).not.toContain('The user stopped this agent deliberately')
  })

  it('tells the parent a lost agent was nobody\u2019s decision, and its work may be half-applied', () => {
    const block = stoppedBy(EKilledBy.Unrecorded)

    expect(block).toContain('was lost before anything recorded how it ended')
    expect(block).toContain('the session it was running in went away')
    expect(block).toContain('may be half-applied')
    expect(block).not.toContain('The user stopped this agent deliberately')
  })

  it('says nothing extra when teardown stopped it', () => {
    const block = stoppedBy(EKilledBy.SessionEnd)

    expect(block).toContain('was stopped when the session closed, after')
    expect(block).not.toContain('The user stopped this agent deliberately')
  })
})
