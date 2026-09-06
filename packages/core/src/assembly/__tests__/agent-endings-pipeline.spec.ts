import { describe, expect, it } from 'bun:test'

import { EAgentStart } from '../../agents/start'
import { EAgentStatus } from '../../agents/status'
import { ECompactionAnchor, type EventDraft } from '../../events/body'
import { toCallId, toThreadId } from '../../events/ids'
import type { CompiledPrompt } from '../../prompt/compiled'
import { ANTHROPIC_PROVIDER_ID } from '../annotators/cache-breakpoints'
import { assemble } from '../assemble'
import { exchangeFaults } from '../exchange-shape'
import { defaultPipeline, defaultRules } from '../pipeline'
import { contextFor, log } from './log-fixture'

const PROJECT_DIRECTORY = '/w'

const DOCTRINE = 'You are Atlas, a coding agent talking to a developer in their terminal.'

const FIRST_CHILD = toThreadId('thread-child-1')
const SECOND_CHILD = toThreadId('thread-child-2')

const compiled = (text: string): CompiledPrompt => ({
  blocks: [{ text }],
  parts: [{ id: 'fixture.doctrine', text, chars: text.length }],
  skipped: [],
})

const spawned = (agentId: string): EventDraft => ({
  type: 'agent-spawned',
  agentId: toThreadId(agentId),
  agentType: 'explore',
  intent: 'count the assemble callers',
  mode: EAgentStart.Fresh,
})

const ended = (over: Partial<Extract<EventDraft, { type: 'agent-ended' }>> = {}): EventDraft => ({
  type: 'agent-ended',
  agentId: FIRST_CHILD,
  agentType: 'explore',
  intent: 'count the assemble callers',
  status: EAgentStatus.Finished,
  prose: 'assemble has four callers, all in the loop.',
  turns: 3,
  toolCalls: 7,
  ...over,
})

const assembledFrom = (drafts: readonly EventDraft[]) => {
  const events = log(drafts)

  return assemble({
    rules: defaultRules({ prompt: () => compiled(DOCTRINE), launchDirectory: PROJECT_DIRECTORY }),
    ctx: contextFor({ events }),
  })
}

const textsOf = (assembled: ReturnType<typeof assembledFrom>['assembled']): readonly string[] =>
  assembled.messages.flatMap((entry) =>
    entry.message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])),
  )

const endingBlocksOf = (
  assembled: ReturnType<typeof assembledFrom>['assembled'],
): readonly string[] => textsOf(assembled).filter((text) => text.startsWith('<agents-ended>'))

const CONVERSATION: readonly EventDraft[] = [
  { type: 'user-said', text: 'find every caller of assemble' },
  { type: 'assistant-said', parts: [{ type: 'text', text: 'I will delegate that.' }] },
  spawned(FIRST_CHILD),
]

describe('the report of a delegate the parent was woken by', () => {
  it('reaches the assembled prompt rather than waking the parent to nothing', () => {
    const { assembled, trace } = assembledFrom([...CONVERSATION, ended()])

    expect(trace.map((step) => step.name)).toContain('agentEndingsBlock')
    expect(endingBlocksOf(assembled)).toHaveLength(1)
    expect(endingBlocksOf(assembled)[0]).toContain('assemble has four callers, all in the loop.')
    expect(endingBlocksOf(assembled)[0]).toContain(FIRST_CHILD)
  })

  it('lands last, in the conversational position the ending arrived at', () => {
    const { assembled } = assembledFrom([...CONVERSATION, ended()])

    expect(assembled.messages.map((entry) => entry.message.role)).toEqual([
      'user',
      'assistant',
      'user',
    ])
    expect(textsOf(assembled).at(-1)).toStartWith('<agents-ended>')
  })

  it('says nothing at all for a thread that spawned nobody, so a child inherits no cost', () => {
    const { assembled } = assembledFrom([
      { type: 'user-said', text: 'count the call sites of assemble' },
      { type: 'assistant-said', parts: [{ type: 'text', text: 'four' }] },
    ])

    expect(endingBlocksOf(assembled)).toEqual([])
    expect(assembled.messages).toHaveLength(2)
  })
})

describe('a bare tool call answering a delegate report', () => {
  const CALLED_AFTER_ENDING: readonly EventDraft[] = [
    ...CONVERSATION,
    ended(),
    { type: 'tool-called', callId: toCallId('call-1'), name: 'read', input: { path: 'a.ts' }, ordinal: 0 },
    { type: 'tool-result', callId: toCallId('call-1'), name: 'read', output: 'export {}' },
  ]

  it('opens a fresh assistant turn after the report rather than gluing the call to the turn before it', () => {
    const { assembled } = assembledFrom(CALLED_AFTER_ENDING)

    expect(assembled.messages.map((entry) => entry.message.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'tool',
    ])
    expect(textsOf(assembled)[2]).toStartWith('<agents-ended>')
  })

  it('assembles without an exchange fault, so the prompt is one Atlas may send', () => {
    const { assembled } = assembledFrom(CALLED_AFTER_ENDING)

    expect(exchangeFaults(assembled)).toEqual([])
  })
})

describe('a wave of delegates that ended together', () => {
  it('is collapsed into one block naming both, not one block each', () => {
    const { assembled } = assembledFrom([
      ...CONVERSATION,
      spawned(SECOND_CHILD),
      ended(),
      ended({ agentId: SECOND_CHILD, prose: 'the loop calls it twice per step.' }),
    ])

    expect(endingBlocksOf(assembled)).toHaveLength(1)

    const block = endingBlocksOf(assembled)[0] ?? ''
    expect(block).toContain('2 agents you spawned ended.')
    expect(block).toContain('assemble has four callers, all in the loop.')
    expect(block).toContain('the loop calls it twice per step.')
  })

  it('gives each report its own budget rather than splitting one between them', () => {
    const first = 'a'.repeat(6_000)
    const second = 'b'.repeat(6_000)

    const { assembled } = assembledFrom([
      ...CONVERSATION,
      spawned(SECOND_CHILD),
      ended({ prose: first }),
      ended({ agentId: SECOND_CHILD, prose: second }),
    ])

    const block = endingBlocksOf(assembled)[0] ?? ''
    expect(block).not.toContain('characters of this report were dropped')
    expect(block).toContain(first)
    expect(block).toContain(second)
    expect(block.length).toBeGreaterThan(first.length + second.length)
  })

  it('keeps two separate waves separate, since each was a moment the parent was woken', () => {
    const { assembled } = assembledFrom([
      ...CONVERSATION,
      ended(),
      { type: 'assistant-said', parts: [{ type: 'text', text: 'noted' }] },
      spawned(SECOND_CHILD),
      ended({ agentId: SECOND_CHILD, prose: 'the loop calls it twice per step.' }),
    ])

    expect(endingBlocksOf(assembled)).toHaveLength(2)
  })
})

describe('an ending the conversation has since compacted', () => {
  it('goes with the range that covers it rather than outliving the summary', () => {
    const { assembled } = assembledFrom([
      ...CONVERSATION,
      ended(),
      {
        type: 'history-compacted',
        anchor: ECompactionAnchor.Prefix,
        fromSeq: 1,
        throughSeq: 4,
        summary: 'The delegate reported on the assemble callers.',
        replaced: 4,
      },
      { type: 'user-said', text: 'now change them' },
    ])

    expect(endingBlocksOf(assembled)).toEqual([])
    expect(textsOf(assembled)[0]).toContain('The delegate reported on the assemble callers.')
  })
})

describe('the block at the tail of the prompt', () => {
  it('keeps the tail for what just happened, while the worktree note rides the system prompt', () => {
    const events = log([
      ...CONVERSATION,
      ended(),
      { type: 'worktree-entered', path: '/w/tree', branch: 'topic', base: 'origin/main' },
    ])

    const { assembled } = assemble({
      rules: defaultRules({
        prompt: () => compiled(DOCTRINE),
        launchDirectory: PROJECT_DIRECTORY,
      }),
      ctx: contextFor({ events }),
    })

    expect(textsOf(assembled).at(-1)).toStartWith('<agents-ended>')
    expect(assembled.system.at(-1)?.text).toContain('You are working in a git worktree at /w/tree')
  })

  it('takes an ordinary cache breakpoint when it is the newest thing in the prompt', () => {
    const events = log([...CONVERSATION, ended()])

    const { assembled } = assemble({
      ...defaultPipeline({ prompt: () => compiled(DOCTRINE), launchDirectory: PROJECT_DIRECTORY }),
      ctx: {
        ...contextFor({ events }),
        provider: { id: ANTHROPIC_PROVIDER_ID, modelId: 'claude-opus-5' },
      },
    })

    expect(assembled.messages.at(-1)?.message.content.at(-1)?.providerOptions).toBeDefined()
  })
})
