import { describe, expect, it } from 'bun:test'

import {
  EBeforeToolDecision,
  EStage,
  EToolEffect,
  toCallId,
  type AfterTool,
  type BeforeTool,
} from '@dltech/atlas-core'

import { HookChain, type RegisteredHook } from '../../hooks/registry'
import { HookedToolDispatcher } from '../dispatch'
import { InMemoryToolRegistry } from '../registry'
import { readCall, toolNamed } from './fixtures'

describe('dispatching a call the before-tool hooks judge', () => {
  it('denies without invoking anything, carrying the reason to the model', async () => {
    const invoked: string[] = []
    const dispatcher = new HookedToolDispatcher({
      registry: new InMemoryToolRegistry([
        toolNamed({
          name: 'read',
          invoke: async () => {
            invoked.push('read')
            return { ok: true, output: '', modelText: 'rendered' }
          },
        }),
      ]),
      hooks: new HookChain({
        beforeTool: [
          {
            name: 'boundary',
            order: { stage: EStage.Guard, nudge: 0 },
            run: async () => ({ decision: EBeforeToolDecision.Deny, reason: 'outside the workspace root' }),
          },
        ],
      }),
    })

    const drafts = await dispatcher.dispatch({ call: readCall, signal: new AbortController().signal })

    expect(drafts).toEqual([
      { type: 'tool-denied', callId: toCallId('call-1'), name: 'read', reason: 'outside the workspace root' },
    ])
    expect(invoked).toEqual([])
  })

  it('asks for approval without invoking anything', async () => {
    const invoked: string[] = []
    const dispatcher = new HookedToolDispatcher({
      registry: new InMemoryToolRegistry([
        toolNamed({
          name: 'read',
          invoke: async () => {
            invoked.push('read')
            return { ok: true, output: '', modelText: 'rendered' }
          },
        }),
      ]),
      hooks: new HookChain({
        beforeTool: [
          {
            name: 'approvals',
            order: { stage: EStage.Policy, nudge: 0 },
            run: async () => ({ decision: EBeforeToolDecision.Ask, reason: 'a human should look' }),
          },
        ],
      }),
    })

    const drafts = await dispatcher.dispatch({ call: readCall, signal: new AbortController().signal })

    expect(drafts).toEqual([{ type: 'approval-requested', callId: toCallId('call-1'), reason: 'a human should look' }])
    expect(invoked).toEqual([])
  })

  it('threads each rewrite through the hooks in order and hands the last one to the tool', async () => {
    const seen: { hook: string; input: unknown; effect: EToolEffect }[] = []
    const rewriter = (name: string, path: string): RegisteredHook<BeforeTool> => ({
      name,
      order: { stage: EStage.Guard, nudge: name === 'first' ? 10 : 20 },
      run: async ({ call }) => {
        seen.push({ hook: name, input: call.input, effect: call.effect })
        return { decision: EBeforeToolDecision.Allow, input: { path } }
      },
    })

    let invokedWith: unknown
    const dispatcher = new HookedToolDispatcher({
      registry: new InMemoryToolRegistry([
        toolNamed({
          name: 'read',
          effect: EToolEffect.Write,
          invoke: async ({ input }) => {
            invokedWith = input
            return { ok: true, output: 'done', modelText: 'rendered' }
          },
        }),
      ]),
      hooks: new HookChain({
        beforeTool: [rewriter('second', '/w/b.ts'), rewriter('first', '/w/a.ts')],
      }),
    })

    await dispatcher.dispatch({ call: readCall, signal: new AbortController().signal })

    expect(seen).toEqual([
      { hook: 'first', input: { path: 'a.ts' }, effect: EToolEffect.Write },
      { hook: 'second', input: { path: '/w/a.ts' }, effect: EToolEffect.Write },
    ])
    expect(invokedWith).toEqual({ path: '/w/b.ts' })
  })

  it('fails closed when a guard throws, denying in the name of that guard', async () => {
    const invoked: string[] = []
    const dispatcher = new HookedToolDispatcher({
      registry: new InMemoryToolRegistry([
        toolNamed({
          name: 'read',
          invoke: async () => {
            invoked.push('read')
            return { ok: true, output: '', modelText: 'rendered' }
          },
        }),
      ]),
      hooks: new HookChain({
        beforeTool: [
          {
            name: 'boundary',
            order: { stage: EStage.Guard, nudge: 0 },
            run: async () => {
              throw new Error('realpath blew up')
            },
          },
        ],
      }),
    })

    const drafts = await dispatcher.dispatch({ call: readCall, signal: new AbortController().signal })

    expect(drafts).toHaveLength(1)
    expect(drafts[0]?.type).toBe('tool-denied')
    const reason = drafts[0]?.type === 'tool-denied' ? drafts[0].reason : ''
    expect(reason).toContain('boundary')
    expect(reason).toContain('realpath blew up')
    expect(invoked).toEqual([])
  })
})

describe('the after-tool observers', () => {
  const observer = (args: { name: string; nudge: number; seen: string[] }): RegisteredHook<AfterTool> => ({
    name: args.name,
    order: { stage: EStage.Observe, nudge: args.nudge },
    run: async ({ call, result }) => {
      args.seen.push(`${args.name}:${call.name}:${result.ok}`)
      return { drafts: [{ type: 'nudge', text: `${args.name} saw it`, lifetimeSteps: 1 }] }
    },
  })

  it('observes a success in order and appends its drafts after the result', async () => {
    const seen: string[] = []
    const dispatcher = new HookedToolDispatcher({
      registry: new InMemoryToolRegistry([toolNamed({ name: 'read', invoke: async () => ({ ok: true, output: 'ok', modelText: 'rendered' }) })]),
      hooks: new HookChain({
        afterTool: [observer({ name: 'second', nudge: 20, seen }), observer({ name: 'first', nudge: 10, seen })],
      }),
    })

    const drafts = await dispatcher.dispatch({ call: readCall, signal: new AbortController().signal })

    expect(drafts.map((draft) => draft.type)).toEqual(['tool-result', 'nudge', 'nudge'])
    expect(seen).toEqual(['first:read:true', 'second:read:true'])
    expect(drafts.slice(1)).toEqual([
      { type: 'nudge', text: 'first saw it', lifetimeSteps: 1 },
      { type: 'nudge', text: 'second saw it', lifetimeSteps: 1 },
    ])
  })

  it('observes a failure too', async () => {
    const seen: string[] = []
    const dispatcher = new HookedToolDispatcher({
      registry: new InMemoryToolRegistry([
        toolNamed({ name: 'read', invoke: async () => ({ ok: false, reason: 'gone' }) }),
      ]),
      hooks: new HookChain({ afterTool: [observer({ name: 'audit', nudge: 0, seen })] }),
    })

    const drafts = await dispatcher.dispatch({ call: readCall, signal: new AbortController().signal })

    expect(seen).toEqual(['audit:read:false'])
    expect(drafts.map((draft) => draft.type)).toEqual(['tool-result', 'nudge'])
  })

  it('cannot annul a result by throwing', async () => {
    const seen: string[] = []
    const dispatcher = new HookedToolDispatcher({
      registry: new InMemoryToolRegistry([toolNamed({ name: 'read', invoke: async () => ({ ok: true, output: 'ok', modelText: 'rendered' }) })]),
      hooks: new HookChain({
        afterTool: [
          {
            name: 'broken',
            order: { stage: EStage.Observe, nudge: 10 },
            run: async () => {
              throw new Error('observer blew up')
            },
          },
          observer({ name: 'later', nudge: 20, seen }),
        ],
      }),
    })

    const drafts = await dispatcher.dispatch({ call: readCall, signal: new AbortController().signal })

    expect(drafts.map((draft) => draft.type)).toEqual(['tool-result', 'nudge'])
    expect(seen).toEqual(['later:read:true'])
  })

  it('is not consulted about a call that never ran', async () => {
    const seen: string[] = []
    const dispatcher = new HookedToolDispatcher({
      registry: new InMemoryToolRegistry([toolNamed({ name: 'read', invoke: async () => ({ ok: true, output: 'ok', modelText: 'rendered' }) })]),
      hooks: new HookChain({
        beforeTool: [
          {
            name: 'boundary',
            order: { stage: EStage.Guard, nudge: 0 },
            run: async () => ({ decision: EBeforeToolDecision.Deny, reason: 'no' }),
          },
        ],
        afterTool: [observer({ name: 'audit', nudge: 0, seen })],
      }),
    })

    const drafts = await dispatcher.dispatch({ call: readCall, signal: new AbortController().signal })

    expect(drafts.map((draft) => draft.type)).toEqual(['tool-denied'])
    expect(seen).toEqual([])
  })
})
