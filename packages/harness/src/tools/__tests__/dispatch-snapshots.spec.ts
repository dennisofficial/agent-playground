import { describe, expect, it } from 'bun:test'

import {
  EBeforeToolDecision,
  EStage,
  EToolEffect,
  toSnapshotId,
  type BeforeTool,
  type EventDraft,
  type SnapshotId,
  type WorkspacePort,
} from '@dltech/atlas-core'

import { HookChain, type RegisteredHook } from '../../hooks/registry'
import { HookedToolDispatcher, type ToolDispatcher } from '../dispatch'
import { InMemoryToolRegistry } from '../registry'
import { readCall, toolNamed } from './fixtures'

type RecordingWorkspace = WorkspacePort & { labels: readonly string[] }

function workspaceRecording(args: { steps: string[]; snapshot?: () => Promise<SnapshotId> }): RecordingWorkspace {
  const labels: string[] = []
  return {
    root: '/workspace',
    labels,
    snapshot: async ({ label }) => {
      labels.push(label)
      args.steps.push('snapshot')
      return args.snapshot === undefined ? toSnapshotId('tree-1') : args.snapshot()
    },
    restore: async () => {
      throw new Error('restore must not be called by dispatch')
    },
  }
}

function dispatchWith(args: {
  effect: EToolEffect
  steps: string[]
  workspace?: WorkspacePort
  invoke?: () => Promise<{ ok: false; reason: string }>
  beforeTool?: readonly RegisteredHook<BeforeTool>[]
}): ToolDispatcher {
  const registry = new InMemoryToolRegistry([
    toolNamed({
      name: 'read',
      effect: args.effect,
      invoke: async () => {
        args.steps.push('invoke')
        if (args.invoke !== undefined) return args.invoke()
        return { ok: true, output: 'done', modelText: 'rendered' }
      },
    }),
  ])

  return new HookedToolDispatcher({
    registry,
    hooks: new HookChain(args.beforeTool === undefined ? {} : { beforeTool: args.beforeTool }),
    ...(args.workspace === undefined ? {} : { workspace: args.workspace }),
  })
}

function snapshotIdOf(draft: EventDraft | undefined): SnapshotId | undefined {
  if (draft === undefined || draft.type !== 'tool-result') return undefined
  return draft.snapshotId
}

describe('dispatching a write-effect tool with a workspace bound', () => {
  it('snapshots the workspace before invoking the tool and puts the id on the result', async () => {
    const steps: string[] = []
    const workspace = workspaceRecording({ steps })
    const dispatcher = dispatchWith({ effect: EToolEffect.Write, steps, workspace })

    const drafts = await dispatcher.dispatch({ call: readCall, signal: new AbortController().signal })

    expect(steps).toEqual(['snapshot', 'invoke'])
    expect(snapshotIdOf(drafts[0])).toBe(toSnapshotId('tree-1'))
    expect(workspace.labels[0]).toContain('read')
    expect(workspace.labels[0]).toContain('run-1:call-1')
  })

  it('still records the snapshot when the tool fails, because it may have written first', async () => {
    const steps: string[] = []
    const dispatcher = dispatchWith({
      effect: EToolEffect.Write,
      steps,
      workspace: workspaceRecording({ steps }),
      invoke: async () => ({ ok: false, reason: 'disk full' }),
    })

    const drafts = await dispatcher.dispatch({ call: readCall, signal: new AbortController().signal })

    expect(snapshotIdOf(drafts[0])).toBe(toSnapshotId('tree-1'))
  })
})

describe('dispatching a destructive-effect tool with a workspace bound', () => {
  it('snapshots the workspace first', async () => {
    const steps: string[] = []
    const dispatcher = dispatchWith({
      effect: EToolEffect.Destructive,
      steps,
      workspace: workspaceRecording({ steps }),
    })

    const drafts = await dispatcher.dispatch({ call: readCall, signal: new AbortController().signal })

    expect(steps).toEqual(['snapshot', 'invoke'])
    expect(snapshotIdOf(drafts[0])).toBe(toSnapshotId('tree-1'))
  })
})

describe('dispatching a read-effect tool with a workspace bound', () => {
  it('takes no snapshot, because a read cannot change the world', async () => {
    const steps: string[] = []
    const dispatcher = dispatchWith({
      effect: EToolEffect.Read,
      steps,
      workspace: workspaceRecording({ steps }),
    })

    const drafts = await dispatcher.dispatch({ call: readCall, signal: new AbortController().signal })

    expect(steps).toEqual(['invoke'])
    expect(snapshotIdOf(drafts[0])).toBeUndefined()
  })
})

describe('dispatching a write-effect tool a hook stops', () => {
  it('takes no snapshot when the call is denied', async () => {
    const steps: string[] = []
    const dispatcher = dispatchWith({
      effect: EToolEffect.Write,
      steps,
      workspace: workspaceRecording({ steps }),
      beforeTool: [
        {
          name: 'deny-everything',
          order: { stage: EStage.Guard, nudge: 0 },
          run: async () => ({ decision: EBeforeToolDecision.Deny, reason: 'no' }),
        },
      ],
    })

    const drafts = await dispatcher.dispatch({ call: readCall, signal: new AbortController().signal })

    expect(steps).toEqual([])
    expect(drafts[0]?.type).toBe('tool-denied')
  })

  it('takes no snapshot while the call is waiting on a human', async () => {
    const steps: string[] = []
    const dispatcher = dispatchWith({
      effect: EToolEffect.Write,
      steps,
      workspace: workspaceRecording({ steps }),
      beforeTool: [
        {
          name: 'ask-first',
          order: { stage: EStage.Policy, nudge: 0 },
          run: async () => ({ decision: EBeforeToolDecision.Ask, reason: 'confirm' }),
        },
      ],
    })

    const drafts = await dispatcher.dispatch({ call: readCall, signal: new AbortController().signal })

    expect(steps).toEqual([])
    expect(drafts[0]?.type).toBe('approval-requested')
  })
})

describe('dispatching a write-effect tool with no workspace bound', () => {
  it('invokes the tool and reports a result carrying no snapshot id at all', async () => {
    const steps: string[] = []
    const dispatcher = dispatchWith({ effect: EToolEffect.Write, steps })

    const drafts = await dispatcher.dispatch({ call: readCall, signal: new AbortController().signal })

    expect(steps).toEqual(['invoke'])
    expect(drafts[0]).toStrictEqual({
      type: 'tool-result',
      callId: readCall.callId,
      name: 'read',
      output: 'done',
      modelText: 'rendered',
    })
  })
})

describe('dispatching a write-effect tool when the snapshot fails', () => {
  it('runs the tool anyway and reports a result with no snapshot id', async () => {
    const steps: string[] = []
    const dispatcher = dispatchWith({
      effect: EToolEffect.Write,
      steps,
      workspace: workspaceRecording({
        steps,
        snapshot: async () => {
          throw new Error('not a git worktree')
        },
      }),
    })

    const drafts = await dispatcher.dispatch({ call: readCall, signal: new AbortController().signal })

    expect(steps).toEqual(['snapshot', 'invoke'])
    expect(snapshotIdOf(drafts[0])).toBeUndefined()
  })
})
