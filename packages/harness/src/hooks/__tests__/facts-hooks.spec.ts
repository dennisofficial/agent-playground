import { describe, expect, test } from 'bun:test'

import {
  EStage,
  EToolEffect,
  NO_FACTS,
  WorkspaceFactsPort,
  toCallId,
  toThreadId,
  type FactRequest,
  type FactWarming,
  type ToolCall,
  type WorkspaceFacts,
} from '@dltech/atlas-core'

import { InvalidateFactsHook } from '../invalidate-facts'
import { PrewarmFactsHook } from '../prewarm-facts'

class SpyFacts extends WorkspaceFactsPort {
  readonly warmed: FactWarming[] = []
  invalidations = 0

  async factsFor(_request: FactRequest): Promise<WorkspaceFacts> {
    return NO_FACTS
  }

  prewarm(warming: FactWarming): void {
    this.warmed.push(warming)
  }

  invalidate(): void {
    this.invalidations += 1
  }
}

const callWith = ({ effect }: { effect: EToolEffect }): ToolCall => ({
  callId: toCallId('call-1'),
  name: 'bash',
  input: {},
  effect,
  threadId: toThreadId('thread-1'),
})

const OK = { ok: true, output: {}, modelText: '' } as const

describe('the hooks that keep the workspace facts fresh', () => {
  test('a read leaves the collected facts standing', async () => {
    const facts = new SpyFacts()
    const hook = new InvalidateFactsHook(facts)

    await hook.run({ call: callWith({ effect: EToolEffect.Read }), result: OK })

    expect(facts.invalidations).toBe(0)
  })

  test('a write and a destructive call both throw the facts away', async () => {
    const facts = new SpyFacts()
    const hook = new InvalidateFactsHook(facts)

    await hook.run({ call: callWith({ effect: EToolEffect.Write }), result: OK })
    await hook.run({ call: callWith({ effect: EToolEffect.Destructive }), result: OK })

    expect(facts.invalidations).toBe(2)
  })

  test('a call that failed still invalidates, because a half-done write changed the tree', async () => {
    const facts = new SpyFacts()
    const hook = new InvalidateFactsHook(facts)

    await hook.run({
      call: callWith({ effect: EToolEffect.Destructive }),
      result: { ok: false, reason: 'interrupted' },
    })

    expect(facts.invalidations).toBe(1)
  })

  test('the turn starts the collection against the project directory it was given', async () => {
    const facts = new SpyFacts()
    const hook = new PrewarmFactsHook(facts, '/repo')

    await hook.run({ threadId: toThreadId('thread-1'), projectDirectory: '/repo/worktrees/one' })

    expect(facts.warmed).toEqual([
      { projectDirectory: '/repo/worktrees/one', launchDirectory: '/repo' },
    ])
  })

  test('the two hooks observe rather than decide, and the invalidation runs last', () => {
    const facts = new SpyFacts()

    expect(new PrewarmFactsHook(facts, '/repo').order).toEqual({
      stage: EStage.Observe,
      nudge: 1,
    })
    expect(new InvalidateFactsHook(facts).order).toEqual({ stage: EStage.Observe, nudge: 2 })
  })
})
