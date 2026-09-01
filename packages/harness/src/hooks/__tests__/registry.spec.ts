import { describe, expect, it } from 'bun:test'

import {
  EBeforeToolDecision,
  EStage,
  HOOK_CONTEXT_KEY,
  toThreadId,
  type AfterTool,
  type AfterTurn,
  type Assembled,
  type BeforeRequest,
  type BeforeStep,
  type BeforeTool,
  type BeforeTurn,
  type Chunk,
  type HookOrder,
  type OnChunk,
  type ProviderPrompt,
} from '@dltech/atlas-core'

import { HookChain, type RegisteredHook } from '../registry'

const allow: BeforeTool = async ({ call }) => ({ decision: EBeforeToolDecision.Allow, input: call.input })

const record: AfterTool = async () => ({})

const guard = (nudge: number): HookOrder => ({ stage: EStage.Guard, nudge })
const policy = (nudge: number): HookOrder => ({ stage: EStage.Policy, nudge })
const observe = (nudge: number): HookOrder => ({ stage: EStage.Observe, nudge })

const assembled: Assembled = { system: [], messages: [] }
const prompt: ProviderPrompt = { instructions: [], messages: [], provider: { id: 'test', modelId: 'test' } }
const delta: Chunk = { type: 'text-delta', id: 'block-1', text: 'hello' }
const threadId = toThreadId('thread-1')

const noting = (args: { name: string; seen: string[] }): void => {
  args.seen.push(args.name)
}

const notingStep = (args: { name: string; order: HookOrder; seen: string[] }): RegisteredHook<BeforeStep> => ({
  name: args.name,
  order: args.order,
  run: async ({ assembled: given }) => {
    noting(args)
    return given
  },
})

const notingRequest = (args: {
  name: string
  order: HookOrder
  seen: string[]
}): RegisteredHook<BeforeRequest> => ({
  name: args.name,
  order: args.order,
  run: async (given) => {
    noting(args)
    return given
  },
})

const notingChunk = (args: { name: string; order: HookOrder; seen: string[] }): RegisteredHook<OnChunk> => ({
  name: args.name,
  order: args.order,
  run: async (given) => {
    noting(args)
    return given
  },
})

const notingTurn = (args: { name: string; order: HookOrder; seen: string[] }): RegisteredHook<AfterTurn> => ({
  name: args.name,
  order: args.order,
  run: async () => {
    noting(args)
    return {}
  },
})

const notingOpening = (args: {
  name: string
  order: HookOrder
  seen: string[]
}): RegisteredHook<BeforeTurn> => ({
  name: args.name,
  order: args.order,
  run: async () => {
    noting(args)
    return {}
  },
})

describe('HookChain', () => {
  it('orders the tool phases once, at construction', () => {
    const chain = new HookChain({
      beforeTool: [
        { name: 'audit', order: observe(0), run: allow },
        { name: 'zebra', order: guard(50), run: allow },
        { name: 'alpha', order: guard(50), run: allow },
        { name: 'first', order: guard(10), run: allow },
      ],
      afterTool: [
        { name: 'later', order: observe(20), run: record },
        { name: 'sooner', order: observe(10), run: record },
      ],
    })

    expect(chain.beforeTool.map((hook) => hook.name)).toEqual(['first', 'alpha', 'zebra', 'audit'])
    expect(chain.afterTool.map((hook) => hook.name)).toEqual(['sooner', 'later'])
  })

  it('runs each phase in the order stage and nudge settled on', async () => {
    const seen: string[] = []
    const chain = new HookChain({
      beforeStep: [
        notingStep({ name: 'budget', order: policy(0), seen }),
        notingStep({ name: 'redact', order: guard(0), seen }),
      ],
      beforeRequest: [
        notingRequest({ name: 'cache-breakpoints', order: observe(0), seen }),
        notingRequest({ name: 'strip-internal-ids', order: guard(0), seen }),
      ],
      onChunk: [
        notingChunk({ name: 'transcript-log', order: observe(0), seen }),
        notingChunk({ name: 'secret-redaction', order: guard(0), seen }),
      ],
      beforeTurn: [
        notingOpening({ name: 'later-opener', order: observe(0), seen }),
        notingOpening({ name: 'first-opener', order: guard(0), seen }),
      ],
      afterTurn: [
        notingTurn({ name: 'zebra', order: observe(5), seen }),
        notingTurn({ name: 'alpha', order: observe(5), seen }),
      ],
    })

    await chain.beforeTurn({ threadId, projectDirectory: '/repo' })
    await chain.beforeStep({ assembled, trace: [] })
    await chain.beforeRequest({ prompt })
    await chain.onChunk({ chunk: delta })
    await chain.afterTurn({ threadId })

    expect(seen).toEqual([
      'first-opener',
      'later-opener',
      'redact',
      'budget',
      'strip-internal-ids',
      'cache-breakpoints',
      'secret-redaction',
      'transcript-log',
      'alpha',
      'zebra',
    ])
  })

  it('threads what one hook returns into the next', async () => {
    const chain = new HookChain({
      beforeStep: [
        {
          name: 'preamble',
          order: guard(0),
          run: async ({ assembled: given }) => ({ ...given, system: [{ text: 'be brief' }] }),
        },
        {
          name: 'shout',
          order: observe(0),
          run: async ({ assembled: given }) => ({
            ...given,
            system: given.system.map((block) => ({ text: block.text.toUpperCase() })),
          }),
        },
      ],
    })

    expect(await chain.beforeStep({ assembled, trace: [] })).toEqual({
      system: [{ text: 'BE BRIEF' }],
      messages: [],
    })
  })

  it('stops at the hook that drops the chunk, leaving the rest unrun', async () => {
    const seen: string[] = []
    const chain = new HookChain({
      onChunk: [
        { name: 'secret-redaction', order: guard(0), run: async () => null },
        notingChunk({ name: 'transcript-log', order: observe(0), seen }),
      ],
    })

    expect(await chain.onChunk({ chunk: delta })).toBeNull()
    expect(seen).toEqual([])
  })

  it('gathers the drafts every thread-scoped hook returns', async () => {
    const chain = new HookChain({
      afterTurn: [
        {
          name: 'first',
          order: guard(0),
          run: async () => ({ drafts: [{ type: 'nudge', text: 'one', lifetimeSteps: 1 }] }),
        },
        {
          name: 'second',
          order: observe(0),
          run: async () => ({ drafts: [{ type: 'nudge', text: 'two', lifetimeSteps: 1 }] }),
        },
      ],
    })

    expect(await chain.afterTurn({ threadId })).toEqual([
      { type: 'nudge', text: 'one', lifetimeSteps: 1 },
      { type: 'nudge', text: 'two', lifetimeSteps: 1 },
    ])
  })

  it('renders additionalContext as a context-loaded draft slotted under the hook that returned it', async () => {
    const chain = new HookChain({
      beforeTurn: [
        { name: 'gitState', order: observe(0), run: async () => ({ additionalContext: '3 files dirty' }) },
      ],
    })

    expect(await chain.beforeTurn({ threadId, projectDirectory: '/repo' })).toEqual([
      { type: 'context-loaded', slot: 'gitState', key: HOOK_CONTEXT_KEY, content: '3 files dirty' },
    ])
  })

  it('carries a hook that returns both, context ahead of drafts', async () => {
    const chain = new HookChain({
      afterTurn: [
        {
          name: 'gitState',
          order: observe(0),
          run: async () => ({
            additionalContext: '3 files dirty',
            drafts: [{ type: 'nudge', text: 'commit first', lifetimeSteps: 1 }],
          }),
        },
      ],
    })

    expect((await chain.afterTurn({ threadId })).map((draft) => draft.type)).toEqual([
      'context-loaded',
      'nudge',
    ])
  })

  it('stands up empty for a harness with no hooks at all', async () => {
    const chain = new HookChain({})

    expect(chain.beforeTool).toEqual([])
    expect(chain.afterTool).toEqual([])
    expect(await chain.beforeStep({ assembled, trace: [] })).toBe(assembled)
    expect(await chain.beforeRequest({ prompt })).toBe(prompt)
    expect(await chain.onChunk({ chunk: delta })).toBe(delta)
    expect(await chain.beforeTurn({ threadId, projectDirectory: '/repo' })).toEqual([])
    expect(await chain.afterTurn({ threadId })).toEqual([])
  })
})
