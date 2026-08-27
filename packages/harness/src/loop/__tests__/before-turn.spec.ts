import { describe, expect, it } from 'bun:test'

import { EStage, HOOK_CONTEXT_KEY, type BeforeTurn } from '@dltech/atlas-core'

import { ETurnStatus } from '..'
import { HookChain, type RegisteredHook } from '../../hooks/registry'
import { openHooked } from './hooked-turn'

describe('BeforeTurn', () => {
  const opening = (args: {
    name: string
    context: string
    seen?: string[]
  }): RegisteredHook<BeforeTurn> => ({
    name: args.name,
    order: { stage: EStage.Observe, nudge: 0 },
    run: async () => {
      args.seen?.push(args.name)
      return { additionalContext: args.context }
    },
  })

  it('reaches the model on the very first step, so its context is in the prompt the turn opens with', async () => {
    const { runner, harness, model } = await openHooked({
      script: [{ text: 'auth' }],
      hooks: new HookChain({ beforeTurn: [opening({ name: 'gitState', context: '3 files dirty' })] }),
    })
    const branch = await harness.branches.create({})

    const outcome = await runner.say({ branchId: branch.id, text: 'what changed?' })

    expect(outcome.status).toBe(ETurnStatus.Completed)
    expect(JSON.stringify(model.doStreamCalls[0]?.prompt)).toContain('3 files dirty')
  })

  it('lands its context as a context-loaded event slotted under the hook name', async () => {
    const { runner, harness } = await openHooked({
      script: [{ text: 'auth' }],
      hooks: new HookChain({ beforeTurn: [opening({ name: 'gitState', context: '3 files dirty' })] }),
    })
    const branch = await harness.branches.create({})

    await runner.say({ branchId: branch.id, text: 'what changed?' })

    const events = await harness.log.read({ branchId: branch.id })
    expect(events.map((event) => event.type)).toEqual(['user-said', 'context-loaded', 'assistant-said'])
    expect(events.flatMap((event) => (event.type === 'context-loaded' ? [event] : []))[0]).toMatchObject({
      slot: 'gitState',
      key: HOOK_CONTEXT_KEY,
      content: '3 files dirty',
    })
  })

  it('runs once per turn, not once per model step, so a tool round trip does not double it', async () => {
    const seen: string[] = []
    const { runner, harness } = await openHooked({
      script: [{ text: 'looking', calls: [{ callId: 'call-1', name: 'touch', input: {} }] }, { text: 'auth' }],
      withTools: true,
      hooks: new HookChain({ beforeTurn: [opening({ name: 'gitState', context: '3 files dirty', seen })] }),
    })
    const branch = await harness.branches.create({})

    await runner.say({ branchId: branch.id, text: 'what changed?' })

    expect(seen).toEqual(['gitState'])
  })

  it('says the same thing on a second turn without adding a second event, because the log dedupes on the digest', async () => {
    const { runner, harness } = await openHooked({
      script: [{ text: 'first' }, { text: 'second' }],
      hooks: new HookChain({ beforeTurn: [opening({ name: 'gitState', context: '3 files dirty' })] }),
    })
    const branch = await harness.branches.create({})

    await runner.say({ branchId: branch.id, text: 'what changed?' })
    await runner.say({ branchId: branch.id, text: 'and now?' })

    const events = await harness.log.read({ branchId: branch.id })
    expect(events.filter((event) => event.type === 'context-loaded')).toHaveLength(1)
  })

  it('supersedes its own earlier context when what it has to say changes', async () => {
    let dirty = 3
    const { runner, harness, model } = await openHooked({
      script: [{ text: 'first' }, { text: 'second' }],
      hooks: new HookChain({
        beforeTurn: [
          {
            name: 'gitState',
            order: { stage: EStage.Observe, nudge: 0 },
            run: async () => ({ additionalContext: `${dirty} files dirty` }),
          },
        ],
      }),
    })
    const branch = await harness.branches.create({})

    await runner.say({ branchId: branch.id, text: 'what changed?' })
    dirty = 1
    await runner.say({ branchId: branch.id, text: 'and now?' })

    const events = await harness.log.read({ branchId: branch.id })
    expect(events.filter((event) => event.type === 'context-loaded')).toHaveLength(2)

    const second = JSON.stringify(model.doStreamCalls[1]?.prompt)
    expect(second).toContain('1 files dirty')
    expect(second).not.toContain('3 files dirty')
  })

  it('appends the drafts a hook returns after its context, and both after the message it opens on', async () => {
    const { runner, harness } = await openHooked({
      script: [{ text: 'auth' }],
      hooks: new HookChain({
        beforeTurn: [
          {
            name: 'gitState',
            order: { stage: EStage.Observe, nudge: 0 },
            run: async () => ({
              additionalContext: '3 files dirty',
              drafts: [{ type: 'nudge', text: 'commit first', lifetimeSteps: 1 }],
            }),
          },
        ],
      }),
    })
    const branch = await harness.branches.create({})

    await runner.say({ branchId: branch.id, text: 'what changed?' })

    const events = await harness.log.read({ branchId: branch.id })
    expect(events.map((event) => event.type)).toEqual([
      'user-said',
      'context-loaded',
      'nudge',
      'assistant-said',
    ])
  })
})
