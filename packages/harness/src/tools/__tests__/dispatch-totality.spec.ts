import { describe, expect, it } from 'bun:test'

import {
  EStage,
  EToolEffect,
  type AfterTool,
  type BeforeTool,
  type EventDraft,
  type WorkspacePort,
} from '@dltech/atlas-core'

import { HookChain, type RegisteredHook } from '../../hooks/registry'
import { HookedToolDispatcher } from '../dispatch'
import { InMemoryToolRegistry } from '../registry'
import { readCall, toolNamed } from './fixtures'

const WORKSPACE_DIRECTORY = '/workspace'

const succeeds = async () => ({ ok: true as const, output: 'done', modelText: 'rendered' })

const guard = (args: { name: string; run: BeforeTool }): RegisteredHook<BeforeTool> => ({
  name: args.name,
  order: { stage: EStage.Guard, nudge: 0 },
  run: args.run,
})

const recorder = (args: { name: string; run: AfterTool }): RegisteredHook<AfterTool> => ({
  name: args.name,
  order: { stage: EStage.Observe, nudge: 0 },
  run: args.run,
})

function dispatcherFor(args: {
  effect?: EToolEffect
  invoke?: () => Promise<{ ok: true; output: unknown; modelText: string }>
  beforeTool?: readonly RegisteredHook<BeforeTool>[]
  afterTool?: readonly RegisteredHook<AfterTool>[]
  workspace?: WorkspacePort
}): HookedToolDispatcher {
  const registry = new InMemoryToolRegistry([
    toolNamed({
      name: 'read',
      effect: args.effect ?? EToolEffect.Read,
      invoke: args.invoke ?? succeeds,
    }),
  ])

  return new HookedToolDispatcher({
    registry,
    hooks: new HookChain({
      ...(args.beforeTool === undefined ? {} : { beforeTool: args.beforeTool }),
      ...(args.afterTool === undefined ? {} : { afterTool: args.afterTool }),
    }),
    ...(args.workspace === undefined ? {} : { workspace: args.workspace }),
  })
}

const settled = (dispatcher: HookedToolDispatcher, call = readCall): Promise<readonly EventDraft[]> =>
  dispatcher.dispatch({ call, signal: new AbortController().signal, projectDirectory: WORKSPACE_DIRECTORY})

describe('dispatch is total: every failure mode still answers the model with a draft', () => {
  it('answers when the tool itself throws', async () => {
    const drafts = await settled(
      dispatcherFor({
        invoke: async () => {
          throw new Error('EMFILE: too many open files')
        },
      }),
    )

    expect(drafts).toHaveLength(1)
    expect(drafts[0]?.type).toBe('tool-result')
  })

  it('answers when a before-tool hook throws', async () => {
    const drafts = await settled(
      dispatcherFor({
        beforeTool: [
          guard({
            name: 'explodes',
            run: async () => {
              throw new Error('the policy store is unreachable')
            },
          }),
        ],
      }),
    )

    expect(drafts).toHaveLength(1)
    expect(drafts[0]?.type).toBe('tool-denied')
  })

  it('answers when an after-tool hook throws, and still runs the rest of the chain', async () => {
    const later: string[] = []
    const drafts = await settled(
      dispatcherFor({
        afterTool: [
          recorder({
            name: 'explodes',
            run: async () => {
              throw new Error('the recorder is unreachable')
            },
          }),
          recorder({
            name: 'records',
            run: async () => {
              later.push('records')
              return {}
            },
          }),
        ],
      }),
    )

    expect(drafts).toHaveLength(1)
    expect(drafts[0]?.type).toBe('tool-result')
    expect(later).toEqual(['records'])
  })

  it('answers when no tool carries the name the model asked for', async () => {
    const drafts = await settled(dispatcherFor({}), { ...readCall, name: 'nonesuch' })

    expect(drafts).toHaveLength(1)
    expect(drafts[0]?.type).toBe('tool-result')
  })

  it('answers when the input does not match the tool schema', async () => {
    const drafts = await settled(dispatcherFor({}), { ...readCall, input: { path: 42 } })

    expect(drafts).toHaveLength(1)
    expect(drafts[0]?.type).toBe('tool-result')
  })
})
