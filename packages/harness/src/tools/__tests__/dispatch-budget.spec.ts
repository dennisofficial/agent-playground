import { describe, expect, it } from 'bun:test'
import { z } from 'zod'

import {
  EBeforeToolDecision,
  EClassifierMode,
  EStage,
  EToolEffect,
  toCallId,
  toRunId,
  toThreadId,
  type BeforeToolOutcome,
  type Consultation,
  type ToolDefinition,
  type ToolInvocation,
} from '@dltech/atlas-core'

import {
  factsInAWorktree,
  hookOver,
  OURS,
  policyIn,
  RecordingFacts,
  SIBLING,
} from '../../classifier/__tests__/fixtures'
import { HookChain } from '../../hooks/registry'
import { EApprovalRouting, HookedToolDispatcher, type DispatchableCall } from '../dispatch'
import { InMemoryToolRegistry } from '../registry'

const A_BUDGET_SHORTER_THAN_THE_HOOK = 20

const bashCall = (command: string): DispatchableCall => ({
  callId: toCallId('call-1'),
  name: 'bash',
  input: { command },
  runId: toRunId('run-1'),
  threadId: toThreadId('thread-1'),
})

const bashTool = (args: { invoked: ToolInvocation[] }): ToolDefinition => ({
  name: 'bash',
  description: 'runs a command',
  effect: EToolEffect.Destructive,
  inputSchema: z.object({ command: z.string(), workdir: z.string().optional() }),
  invoke: async (invocation: ToolInvocation) => {
    args.invoked.push(invocation)
    return { ok: true, output: '', modelText: 'ran' }
  },
})

const neverAnswering = <T>(): Promise<T> => new Promise<T>(() => {})

const dispatcherOver = (args: {
  hooks: HookChain
  invoked: ToolInvocation[]
}): HookedToolDispatcher =>
  new HookedToolDispatcher({
    approvals: EApprovalRouting.Operator,
    registry: new InMemoryToolRegistry([bashTool({ invoked: args.invoked })]),
    hooks: args.hooks,
  })

describe('a before-tool hook that runs out of time', () => {
  it('lets a classifier too slow to answer fall silent instead of refusing the call', async () => {
    const invoked: ToolInvocation[] = []
    const classifier = hookOver({
      facts: new RecordingFacts(factsInAWorktree({ siblingChangedCount: 12 })),
      policy: policyIn(EClassifierMode.Nudge),
      judge: { consult: () => neverAnswering<Consultation>() },
    })

    const drafts = await dispatcherOver({
      invoked,
      hooks: new HookChain({
        beforeTool: [classifier],
        budgetMs: A_BUDGET_SHORTER_THAN_THE_HOOK,
      }),
    }).dispatch({
      call: bashCall(`rm -rf ${SIBLING}`),
      signal: new AbortController().signal,
      projectDirectory: OURS,
      events: [],
    })

    expect(drafts.map((draft) => draft.type)).toEqual(['tool-result'])
    expect(invoked).toHaveLength(1)
  })

  it('keeps the input an earlier hook resolved rather than losing it to the silence', async () => {
    const invoked: ToolInvocation[] = []
    const mishaps: string[] = []

    const drafts = await dispatcherOver({
      invoked,
      hooks: new HookChain({
        budgetMs: A_BUDGET_SHORTER_THAN_THE_HOOK,
        onMishap: (mishap) => mishaps.push(`${mishap.label}:${mishap.kind}`),
        beforeTool: [
          {
            name: 'resolvePaths',
            order: { stage: EStage.Guard, nudge: -1 },
            run: async () => ({
              decision: EBeforeToolDecision.Allow,
              input: { command: 'ls', workdir: OURS },
            }),
          },
          {
            name: 'dawdles',
            order: { stage: EStage.Policy, nudge: 0 },
            run: () => neverAnswering<BeforeToolOutcome>(),
          },
        ],
      }),
    }).dispatch({
      call: bashCall('ls'),
      signal: new AbortController().signal,
      projectDirectory: OURS,
      events: [],
    })

    expect(drafts.map((draft) => draft.type)).toEqual(['tool-result'])
    expect(invoked[0]?.input).toEqual({ command: 'ls', workdir: OURS })
    expect(mishaps).toEqual(['dawdles:overran'])
  })

  it('still refuses the call when a hook fails outright, which is an answer', async () => {
    const invoked: ToolInvocation[] = []

    const drafts = await dispatcherOver({
      invoked,
      hooks: new HookChain({
        beforeTool: [
          {
            name: 'boundary',
            order: { stage: EStage.Guard, nudge: 0 },
            run: async () => {
              throw new Error('the policy store is unreachable')
            },
          },
        ],
      }),
    }).dispatch({
      call: bashCall('ls'),
      signal: new AbortController().signal,
      projectDirectory: OURS,
      events: [],
    })

    expect(drafts.map((draft) => draft.type)).toEqual(['tool-denied'])
    expect(invoked).toHaveLength(0)
  })
})
