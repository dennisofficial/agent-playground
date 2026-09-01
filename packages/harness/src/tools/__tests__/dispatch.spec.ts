import { describe, expect, it } from 'bun:test'

import { z } from 'zod'

import {
  EBeforeToolDecision,
  EStage,
  EToolEffect,
  stampDrafts,
  toCallId,
  toEventId,
  toRunId,
  toThreadId,
  type BeforeTool,
  type BeforeToolOutcome,
  type Event,
  type EventDraft,
  type ToolCall,
  type ToolDefinition,
  type ToolInvocation,
} from '@dltech/atlas-core'

import { HookChain, type RegisteredHook } from '../../hooks/registry'
import { EApprovalRouting, HookedToolDispatcher } from '../dispatch'
import { InMemoryToolRegistry } from '../registry'
import { readCall, toolNamed } from './fixtures'

const SESSION_DIRECTORY = '/workspace'

describe('dispatching a call for a tool nobody registered', () => {
  it('answers the model with an error result naming the tool and what is available', async () => {
    const dispatcher = new HookedToolDispatcher({
      approvals: EApprovalRouting.Operator,
      registry: new InMemoryToolRegistry([toolNamed({ name: 'glob', invoke: async () => ({ ok: true, output: '', modelText: 'rendered' }) })]),
      hooks: new HookChain({}),
    })

    const drafts = await dispatcher.dispatch({ call: readCall, signal: new AbortController().signal, projectDirectory: SESSION_DIRECTORY, events: [] })

    expect(drafts).toHaveLength(1)
    expect(drafts[0]?.type).toBe('tool-result')
    const message = drafts[0]?.type === 'tool-result' ? (drafts[0].error?.message ?? '') : ''
    expect(message).toContain('read')
    expect(message).toContain('glob')
  })
})

describe('dispatching a call no hook objects to', () => {
  it('invokes the tool and reports its output, keyed by the run that emitted the call', async () => {
    const invocations: ToolInvocation[] = []
    const dispatcher = new HookedToolDispatcher({
      approvals: EApprovalRouting.Operator,
      registry: new InMemoryToolRegistry([
        toolNamed({
          name: 'read',
          invoke: async (invocation) => {
            invocations.push(invocation)
            return { ok: true, output: '1\tconst a = 1', modelText: 'rendered' }
          },
        }),
      ]),
      hooks: new HookChain({}),
    })

    const drafts = await dispatcher.dispatch({ call: readCall, signal: new AbortController().signal, projectDirectory: SESSION_DIRECTORY, events: [] })

    expect(drafts).toEqual([
      {
        type: 'tool-result',
        callId: toCallId('call-1'),
        name: 'read',
        output: '1\tconst a = 1',
        modelText: 'rendered',
      },
    ])
    expect(invocations.map((invocation) => invocation.idempotencyKey)).toEqual(['run-1:call-1'])
    expect(invocations[0]?.input).toEqual({ path: 'a.ts' })
  })
})

describe('dispatching a call the tool itself cannot complete', () => {
  it('renders a refused invocation as an error result the model can read', async () => {
    const dispatcher = new HookedToolDispatcher({
      approvals: EApprovalRouting.Operator,
      registry: new InMemoryToolRegistry([
        toolNamed({ name: 'read', invoke: async () => ({ ok: false, reason: 'a.ts does not exist' }) }),
      ]),
      hooks: new HookChain({}),
    })

    const drafts = await dispatcher.dispatch({ call: readCall, signal: new AbortController().signal, projectDirectory: SESSION_DIRECTORY, events: [] })

    expect(drafts).toEqual([
      {
        type: 'tool-result',
        callId: toCallId('call-1'),
        name: 'read',
        output: undefined,
        error: { message: 'a.ts does not exist' },
      },
    ])
  })

  it('survives a tool that throws rather than letting it kill the turn', async () => {
    const dispatcher = new HookedToolDispatcher({
      approvals: EApprovalRouting.Operator,
      registry: new InMemoryToolRegistry([
        toolNamed({
          name: 'read',
          invoke: async () => {
            throw new Error('EMFILE: too many open files')
          },
        }),
      ]),
      hooks: new HookChain({}),
    })

    const drafts = await dispatcher.dispatch({ call: readCall, signal: new AbortController().signal, projectDirectory: SESSION_DIRECTORY, events: [] })

    expect(drafts).toHaveLength(1)
    const error = drafts[0]?.type === 'tool-result' ? drafts[0].error?.message : undefined
    expect(error).toContain('EMFILE: too many open files')
  })
})

describe('the two projections of a successful result', () => {
  it("carries the tool's model-facing text onto the draft", async () => {
    const dispatcher = new HookedToolDispatcher({
      approvals: EApprovalRouting.Operator,
      registry: new InMemoryToolRegistry([
        toolNamed({
          name: 'read',
          invoke: async () => ({
            ok: true,
            output: { path: 'a.ts', lines: 1, patch: '@@ -1 +1 @@' },
            modelText: 'The file a.ts has been updated successfully.',
          }),
        }),
      ]),
      hooks: new HookChain({}),
    })

    const drafts = await dispatcher.dispatch({ call: readCall, signal: new AbortController().signal, projectDirectory: SESSION_DIRECTORY, events: [] })

    expect(drafts).toEqual([
      {
        type: 'tool-result',
        callId: toCallId('call-1'),
        name: 'read',
        output: { path: 'a.ts', lines: 1, patch: '@@ -1 +1 @@' },
        modelText: 'The file a.ts has been updated successfully.',
      },
    ])
  })

  it('leaves an empty model-facing text empty rather than deciding what the model reads', async () => {
    const dispatcher = new HookedToolDispatcher({
      approvals: EApprovalRouting.Operator,
      registry: new InMemoryToolRegistry([
        toolNamed({ name: 'read', invoke: async () => ({ ok: true, output: 'contents', modelText: '' }) }),
      ]),
      hooks: new HookChain({}),
    })

    const drafts = await dispatcher.dispatch({ call: readCall, signal: new AbortController().signal, projectDirectory: SESSION_DIRECTORY, events: [] })

    expect(drafts[0]?.type === 'tool-result' ? drafts[0].modelText : 'absent').toBe('')
  })

  it('leaves the model-facing text off a failure, whose voice is the error', async () => {
    const dispatcher = new HookedToolDispatcher({
      approvals: EApprovalRouting.Operator,
      registry: new InMemoryToolRegistry([
        toolNamed({ name: 'read', invoke: async () => ({ ok: false, reason: 'a.ts does not exist' }) }),
      ]),
      hooks: new HookChain({}),
    })

    const drafts = await dispatcher.dispatch({ call: readCall, signal: new AbortController().signal, projectDirectory: SESSION_DIRECTORY, events: [] })

    expect(drafts[0]?.type === 'tool-result' ? drafts[0].modelText : 'present').toBeUndefined()
  })
})

describe('dispatching a call whose input the tool schema rejects', () => {
  it('answers with an error result and never invokes the tool', async () => {
    let invoked = false
    const dispatcher = new HookedToolDispatcher({
      approvals: EApprovalRouting.Operator,
      registry: new InMemoryToolRegistry([
        toolNamed({
          name: 'read',
          invoke: async () => {
            invoked = true
            return { ok: true, output: '', modelText: 'rendered' }
          },
        }),
      ]),
      hooks: new HookChain({}),
    })

    const drafts = await dispatcher.dispatch({
      call: { ...readCall, input: {} },
      signal: new AbortController().signal,
      projectDirectory: SESSION_DIRECTORY,
      events: [],
    })

    expect(invoked).toBe(false)
    expect(drafts).toHaveLength(1)
    expect(drafts[0]?.type).toBe('tool-result')
    const message = drafts[0]?.type === 'tool-result' ? (drafts[0].error?.message ?? '') : ''
    expect(message).toContain('read')
    expect(message).toContain('path')
  })
})

const strictReadTool = (args: {
  invoke: (invocation: ToolInvocation) => Promise<{ ok: true; output: unknown; modelText: string }>
}): ToolDefinition => ({
  name: 'read',
  description: 'the read tool',
  effect: EToolEffect.Read,
  inputSchema: z.strictObject({ path: z.string(), limit: z.number().default(50) }),
  invoke: args.invoke,
})

const succeeds = async () => ({ ok: true as const, output: '', modelText: 'rendered' })

describe('dispatching a call carrying a key the tool never declared', () => {
  it('rejects it rather than quietly ignoring it, as strictObject asks', async () => {
    let invoked = false
    const dispatcher = new HookedToolDispatcher({
      approvals: EApprovalRouting.Operator,
      registry: new InMemoryToolRegistry([
        strictReadTool({
          invoke: async () => {
            invoked = true
            return succeeds()
          },
        }),
      ]),
      hooks: new HookChain({}),
    })

    const drafts = await dispatcher.dispatch({
      call: { ...readCall, input: { path: 'a.ts', sudo: true } },
      signal: new AbortController().signal,
      projectDirectory: SESSION_DIRECTORY,
      events: [],
    })

    expect(invoked).toBe(false)
    const message = drafts[0]?.type === 'tool-result' ? (drafts[0].error?.message ?? '') : ''
    expect(message).toContain('sudo')
  })
})

describe('dispatching a call the schema accepts and completes', () => {
  it('hands the tool the parsed input, not the raw input the model sent', async () => {
    const invocations: ToolInvocation[] = []
    const dispatcher = new HookedToolDispatcher({
      approvals: EApprovalRouting.Operator,
      registry: new InMemoryToolRegistry([
        strictReadTool({
          invoke: async (invocation) => {
            invocations.push(invocation)
            return succeeds()
          },
        }),
      ]),
      hooks: new HookChain({}),
    })

    await dispatcher.dispatch({ call: { ...readCall, input: { path: 'a.ts' } }, signal: new AbortController().signal, projectDirectory: SESSION_DIRECTORY, events: [] })

    expect(invocations[0]?.input).toEqual({ path: 'a.ts', limit: 50 })
  })

  it('shows a before-tool hook the parsed input, so a guard need not do input archaeology', async () => {
    const seen: unknown[] = []
    const watching: BeforeTool = async ({ call }: { call: ToolCall }) => {
      seen.push(call.input)
      return { decision: EBeforeToolDecision.Allow, input: call.input }
    }

    const dispatcher = new HookedToolDispatcher({
      approvals: EApprovalRouting.Operator,
      registry: new InMemoryToolRegistry([strictReadTool({ invoke: succeeds })]),
      hooks: new HookChain({
        beforeTool: [{ name: 'watcher', order: { stage: EStage.Guard, nudge: 0 }, run: watching }],
      }),
    })

    await dispatcher.dispatch({ call: { ...readCall, input: { path: 'a.ts' } }, signal: new AbortController().signal, projectDirectory: SESSION_DIRECTORY, events: [] })

    expect(seen).toEqual([{ path: 'a.ts', limit: 50 }])
  })
})

const noted = (text: string): EventDraft => ({ type: 'nudge', text, lifetimeSteps: 1 })

const speaking = (args: {
  name: string
  text: string
  nudge?: number
  outcome: (call: ToolCall) => BeforeToolOutcome
}): RegisteredHook<BeforeTool> => ({
  name: args.name,
  order: { stage: EStage.Policy, nudge: args.nudge ?? 0 },
  run: async ({ call }) => ({ ...args.outcome(call), drafts: [noted(args.text)] }),
})

const dispatcherHearing = (
  hooks: readonly RegisteredHook<BeforeTool>[],
): HookedToolDispatcher =>
  new HookedToolDispatcher({
    approvals: EApprovalRouting.Operator,
    registry: new InMemoryToolRegistry([toolNamed({ name: 'read', invoke: succeeds })]),
    hooks: new HookChain({ beforeTool: hooks }),
  })

const dispatched = (dispatcher: HookedToolDispatcher): Promise<readonly EventDraft[]> =>
  dispatcher.dispatch({
    call: readCall,
    signal: new AbortController().signal,
    projectDirectory: SESSION_DIRECTORY,
    events: [],
  })

describe('what a before-tool hook says while the dispatcher decides', () => {
  it('records the draft ahead of the result when the call was allowed', async () => {
    const drafts = await dispatched(
      dispatcherHearing([
        speaking({
          name: 'classify',
          text: 'judged clear',
          outcome: (call) => ({ decision: EBeforeToolDecision.Allow, input: call.input }),
        }),
      ]),
    )

    expect(drafts.map((draft) => draft.type)).toEqual(['nudge', 'tool-result'])
  })

  it('records the draft ahead of the question when the call was paused', async () => {
    const drafts = await dispatched(
      dispatcherHearing([
        speaking({
          name: 'classify',
          text: 'judged check',
          outcome: () => ({ decision: EBeforeToolDecision.Ask, reason: 'reach: outside the project' }),
        }),
      ]),
    )

    expect(drafts.map((draft) => draft.type)).toEqual(['nudge', 'approval-requested'])
  })

  it('records the draft ahead of the refusal when the call was denied', async () => {
    const drafts = await dispatched(
      dispatcherHearing([
        speaking({
          name: 'guard',
          text: 'judged unsafe',
          outcome: () => ({ decision: EBeforeToolDecision.Deny, reason: 'outside the workspace root' }),
        }),
      ]),
    )

    expect(drafts.map((draft) => draft.type)).toEqual(['nudge', 'tool-denied'])
  })

  it('keeps what an allowing hook said even though a later hook took the decision away', async () => {
    const drafts = await dispatched(
      dispatcherHearing([
        speaking({
          name: 'classify',
          text: 'judged clear',
          outcome: (call) => ({ decision: EBeforeToolDecision.Allow, input: call.input }),
        }),
        speaking({
          name: 'approvals',
          text: 'asked the operator',
          nudge: 1,
          outcome: () => ({ decision: EBeforeToolDecision.Ask, reason: 'writes need a human' }),
        }),
      ]),
    )

    expect(drafts).toEqual([
      noted('judged clear'),
      noted('asked the operator'),
      { type: 'approval-requested', callId: toCallId('call-1'), reason: 'writes need a human' },
    ])
  })

  it('says nothing extra for a hook that wrote no draft', async () => {
    const drafts = await dispatched(
      dispatcherHearing([
        {
          name: 'quiet',
          order: { stage: EStage.Policy, nudge: 0 },
          run: async ({ call }) => ({ decision: EBeforeToolDecision.Allow, input: call.input }),
        },
      ]),
    )

    expect(drafts.map((draft) => draft.type)).toEqual(['tool-result'])
  })
})

describe('what a before-tool hook is handed beyond the call', () => {
  it('forwards the thread the dispatcher was given, so a hook can read the log', async () => {
    const seen: (readonly Event[])[] = []
    const events = stampDrafts({
      drafts: [{ type: 'user-said', text: 'clean it up' }],
      envelopes: [
        {
          id: toEventId('evt-1'),
          seq: 1,
          threadId: toThreadId('thread-1'),
          runId: toRunId('run-1'),
          depth: 0,
          at: '2026-09-01T00:00:00.000Z',
        },
      ],
    })

    const dispatcher = new HookedToolDispatcher({
      approvals: EApprovalRouting.Operator,
      registry: new InMemoryToolRegistry([toolNamed({ name: 'read', invoke: succeeds })]),
      hooks: new HookChain({
        beforeTool: [
          {
            name: 'reader',
            order: { stage: EStage.Policy, nudge: 0 },
            run: async ({ call, events: seenEvents }) => {
              seen.push(seenEvents)
              return { decision: EBeforeToolDecision.Allow, input: call.input }
            },
          },
        ],
      }),
    })

    await dispatcher.dispatch({
      call: readCall,
      signal: new AbortController().signal,
      projectDirectory: SESSION_DIRECTORY,
      events,
    })

    expect(seen).toEqual([events])
  })

  it('forwards the abort signal it already holds, so a hook can give up with the turn', async () => {
    const controller = new AbortController()
    let aborted: boolean | undefined
    const dispatcher = new HookedToolDispatcher({
      approvals: EApprovalRouting.Operator,
      registry: new InMemoryToolRegistry([toolNamed({ name: 'read', invoke: succeeds })]),
      hooks: new HookChain({
        beforeTool: [
          {
            name: 'watcher',
            order: { stage: EStage.Policy, nudge: 0 },
            run: async ({ call, signal }) => {
              aborted = signal.aborted
              return { decision: EBeforeToolDecision.Allow, input: call.input }
            },
          },
        ],
      }),
    })

    controller.abort()
    await dispatcher.dispatch({
      call: readCall,
      signal: controller.signal,
      projectDirectory: SESSION_DIRECTORY,
      events: [],
    })

    expect(aborted).toBe(true)
  })
})
