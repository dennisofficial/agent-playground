import { describe, expect, it } from 'bun:test'

import {
  EStage,
  toThreadId,
  type Assembled,
  type Chunk,
  type EventDraft,
  type HookOutcome,
  type ProviderPrompt,
} from '@dltech/atlas-core'

import { EHookMishapKind, type HookMishap } from '../budget'
import { HookChain, type RegisteredHook } from '../registry'

const THREAD = toThreadId('thread-isolation')

const BUDGET_MS = 5

const ASSEMBLED: Assembled = { system: [{ text: 'original' }], messages: [] }

const PROMPT: ProviderPrompt = {
  instructions: [{ text: 'original' }],
  messages: [],
  provider: { id: 'anthropic', modelId: 'claude' },
}

const CHUNK: Chunk = { type: 'text-delta', id: 'block', text: 'original' }

const order = (nudge: number) => ({ stage: EStage.Observe, nudge })

const never = <T>(): Promise<T> => new Promise<T>(() => {})

const collect = (): { seen: HookMishap[]; onMishap: (mishap: HookMishap) => void } => {
  const seen: HookMishap[] = []
  return { seen, onMishap: (mishap) => seen.push(mishap) }
}

const said = (text: string): HookOutcome => ({ additionalContext: text })

const contextOf = (drafts: readonly EventDraft[]): readonly string[] =>
  drafts.flatMap((draft) => (draft.type === 'context-loaded' ? [draft.content] : []))

describe('a collect phase survives a hook that misbehaves', () => {
  const chainWith = (
    hooks: readonly RegisteredHook<() => Promise<HookOutcome>>[],
    onMishap: (mishap: HookMishap) => void,
  ) => new HookChain({ beforeTurn: hooks, onMishap, budgetMs: BUDGET_MS })

  it('keeps the drafts of the hooks either side of a thrower', async () => {
    const { seen, onMishap } = collect()
    const chain = chainWith(
      [
        { name: 'first', order: order(1), run: async () => said('one') },
        {
          name: 'thrower',
          order: order(2),
          run: async () => {
            throw new Error('boom')
          },
        },
        { name: 'third', order: order(3), run: async () => said('three') },
      ],
      onMishap,
    )

    const drafts = await chain.beforeTurn({ threadId: THREAD, projectDirectory: '/repo' })

    expect(contextOf(drafts)).toEqual(['one', 'three'])
    expect(seen).toEqual([{ label: 'thrower', kind: EHookMishapKind.Threw, detail: 'boom' }])
  })

  it('drops a hanging hook at the budget and still returns', async () => {
    const { seen, onMishap } = collect()
    const chain = chainWith(
      [
        { name: 'hanger', order: order(1), run: never<HookOutcome> },
        { name: 'after', order: order(2), run: async () => said('after') },
      ],
      onMishap,
    )

    expect(contextOf(await chain.beforeTurn({ threadId: THREAD, projectDirectory: '/repo' }))).toEqual([
      'after',
    ])
    expect(seen.map((mishap) => mishap.kind)).toEqual([EHookMishapKind.Overran])
  })

  it('does not shift the ordering of the hooks that follow a failure', async () => {
    const { onMishap } = collect()
    const chain = chainWith(
      [
        { name: 'c', order: order(3), run: async () => said('c') },
        {
          name: 'a',
          order: order(1),
          run: async () => {
            throw new Error('boom')
          },
        },
        { name: 'b', order: order(2), run: async () => said('b') },
      ],
      onMishap,
    )

    expect(contextOf(await chain.beforeTurn({ threadId: THREAD, projectDirectory: '/repo' }))).toEqual([
      'b',
      'c',
    ])
  })
})

describe('a transform phase passes its value through when a hook misbehaves', () => {
  it('keeps the assembled prompt when a beforeStep hook throws', async () => {
    const { seen, onMishap } = collect()
    const chain = new HookChain({
      beforeStep: [
        {
          name: 'thrower',
          order: order(1),
          run: async () => {
            throw new Error('boom')
          },
        },
      ],
      onMishap,
      budgetMs: BUDGET_MS,
    })

    expect(await chain.beforeStep({ assembled: ASSEMBLED, trace: [] })).toEqual(ASSEMBLED)
    expect(seen.map((mishap) => mishap.kind)).toEqual([EHookMishapKind.Threw])
  })

  it('does not hand the next step undefined when a beforeStep hook forgets to return', async () => {
    const { seen, onMishap } = collect()
    const chain = new HookChain({
      beforeStep: [
        { name: 'forgetful', order: order(1), run: async () => undefined as unknown as Assembled },
      ],
      onMishap,
      budgetMs: BUDGET_MS,
    })

    expect(await chain.beforeStep({ assembled: ASSEMBLED, trace: [] })).toEqual(ASSEMBLED)
    expect(seen).toEqual([
      { label: 'forgetful', kind: EHookMishapKind.ReturnedNothing, detail: 'returned undefined' },
    ])
  })

  it('keeps the provider prompt when a beforeRequest hook hangs', async () => {
    const { seen, onMishap } = collect()
    const chain = new HookChain({
      beforeRequest: [{ name: 'hanger', order: order(1), run: never<ProviderPrompt> }],
      onMishap,
      budgetMs: BUDGET_MS,
    })

    expect(await chain.beforeRequest({ prompt: PROMPT })).toEqual(PROMPT)
    expect(seen.map((mishap) => mishap.kind)).toEqual([EHookMishapKind.Overran])
  })
})

describe('onChunk', () => {
  it('still drops the chunk when a hook deliberately returns null', async () => {
    const { seen, onMishap } = collect()
    const chain = new HookChain({
      onChunk: [{ name: 'redactor', order: order(1), run: async () => null }],
      onMishap,
      budgetMs: BUDGET_MS,
    })

    expect(await chain.onChunk({ chunk: CHUNK })).toBeNull()
    expect(seen).toEqual([])
  })

  it('does not mute the stream when a hook forgets to return', async () => {
    const { seen, onMishap } = collect()
    const chain = new HookChain({
      onChunk: [{ name: 'forgetful', order: order(1), run: async () => undefined as unknown as Chunk }],
      onMishap,
      budgetMs: BUDGET_MS,
    })

    expect(await chain.onChunk({ chunk: CHUNK })).toEqual(CHUNK)
    expect(seen.map((mishap) => mishap.kind)).toEqual([EHookMishapKind.ReturnedNothing])
  })

  it('passes the chunk through when a hook throws', async () => {
    const { seen, onMishap } = collect()
    const chain = new HookChain({
      onChunk: [
        {
          name: 'thrower',
          order: order(1),
          run: async () => {
            throw new Error('boom')
          },
        },
      ],
      onMishap,
      budgetMs: BUDGET_MS,
    })

    expect(await chain.onChunk({ chunk: CHUNK })).toEqual(CHUNK)
    expect(seen.map((mishap) => mishap.kind)).toEqual([EHookMishapKind.Threw])
  })
})

describe('a chain with no reporter', () => {
  it('still isolates, so the absence of onMishap is never why a turn fails', async () => {
    const chain = new HookChain({
      afterTurn: [
        {
          name: 'thrower',
          order: order(1),
          run: async () => {
            throw new Error('boom')
          },
        },
      ],
      budgetMs: BUDGET_MS,
    })

    expect(await chain.afterTurn({ threadId: THREAD })).toEqual([])
  })
})
