import { afterEach, describe, expect, it } from 'bun:test'
import { z } from 'zod'

import {
  EBeforeToolDecision,
  EDecision,
  EStage,
  EToolEffect,
  toCallId,
  type BeforeTool,
  type RunId,
  type ThreadId,
  type ToolDefinition,
} from '@dltech/atlas-core'

import { HookChain } from '../../hooks/registry'
import { scriptedModel } from '../../model/testing/scripted-model'
import { HookedToolDispatcher, type DispatchableCall } from '../../tools/dispatch'
import { InMemoryToolRegistry } from '../../tools/registry'
import { buildHarness, ETurnStatus, type AtlasHarness } from '..'
import { createSettlePending } from '../settle-pending'
import { fixturePrompt } from './fixture-prompt'
import {
  branchWithCalls,
  discardOpened,
  keepOpen,
  openLog,
  scriptedDispatch,
} from './settle-pending-fixture'
import { createTempDatabase } from './temp-database'

afterEach(discardOpened)

const OPERATOR_DECLINED = 'the operator declined this call'

const ASK_REASON = 'editing a.ts needs a human'

function recordingEditTool(invoked: unknown[]): ToolDefinition {
  return {
    name: 'edit',
    description: 'edit a file',
    effect: EToolEffect.Write,
    inputSchema: z.object({ path: z.string() }),
    invoke: async ({ input }) => {
      invoked.push(input)
      return { ok: true, output: 'wrote', modelText: 'wrote' }
    },
  }
}

function guardChain(args: { name: string; run: BeforeTool }): HookChain {
  return new HookChain({
    beforeTool: [{ name: args.name, order: { stage: EStage.Guard, nudge: 0 }, run: args.run }],
  })
}

async function answerApproval(args: {
  harness: AtlasHarness
  threadId: ThreadId
  runId: RunId
  callId: string
  reason: string
  decision: EDecision
  editedInput?: unknown
}): Promise<void> {
  await args.harness.log.append({
    threadId: args.threadId,
    runId: args.runId,
    drafts: [
      { type: 'approval-requested', callId: toCallId(args.callId), reason: args.reason },
      {
        type: 'approval-answered',
        callId: toCallId(args.callId),
        decision: args.decision,
        ...(args.editedInput === undefined ? {} : { editedInput: args.editedInput }),
      },
    ],
  })
}

const deniedIn = (events: readonly { type: string }[]): unknown =>
  events.find((event) => event.type === 'tool-denied')

describe('an approval the operator has already answered', () => {
  it('emits tool-denied for a refusal, never runs the tool, and lets the turn complete', async () => {
    const temp = createTempDatabase()
    const invoked: unknown[] = []
    const tools = new InMemoryToolRegistry([recordingEditTool(invoked)])
    const hooks = guardChain({
      name: 'alwaysAsks',
      run: async () => ({ decision: EBeforeToolDecision.Ask, reason: ASK_REASON }),
    })
    const harness = await buildHarness({
      databaseUrl: temp.databaseUrl,
      model: scriptedModel({ script: [{ text: 'understood, leaving it alone' }] }),
      prompt: fixturePrompt(),
      tools: tools.declarations(),
      dispatch: new HookedToolDispatcher({ registry: tools, hooks }),
      hooks,
    })
    keepOpen({ harness, temp })

    const { threadId, runId } = await branchWithCalls({
      harness,
      calls: [{ callId: 'call-1', name: 'edit', input: { path: 'a.ts' } }],
    })
    await answerApproval({
      harness,
      threadId,
      runId,
      callId: 'call-1',
      reason: ASK_REASON,
      decision: EDecision.Deny,
    })

    const outcome = await harness.runner.runTurn({ threadId })

    expect(outcome.status).toBe(ETurnStatus.Completed)
    expect(invoked).toEqual([])

    const events = await harness.log.read({ threadId })
    expect(deniedIn(events)).toMatchObject({
      callId: toCallId('call-1'),
      name: 'edit',
      reason: `${OPERATOR_DECLINED}: ${ASK_REASON}`,
    })
    expect(events.filter((event) => event.type === 'approval-requested')).toHaveLength(1)
  })

  it('dispatches an allowed call with the edited input, so every guard hook re-reads it', async () => {
    const harness = await openLog()
    const invoked: unknown[] = []
    const seenByGuard: unknown[] = []
    const tools = new InMemoryToolRegistry([recordingEditTool(invoked)])
    const hooks = guardChain({
      name: 'watchesInput',
      run: async ({ call }) => {
        seenByGuard.push(call.input)
        return { decision: EBeforeToolDecision.Allow, input: call.input }
      },
    })

    const { threadId, runId } = await branchWithCalls({
      harness,
      calls: [{ callId: 'call-1', name: 'edit', input: { path: 'a.ts' } }],
    })
    await answerApproval({
      harness,
      threadId,
      runId,
      callId: 'call-1',
      reason: ASK_REASON,
      decision: EDecision.Allow,
      editedInput: { path: 'b.ts' },
    })

    const settle = createSettlePending({
      log: harness.log,
      dispatch: new HookedToolDispatcher({ registry: tools, hooks }),
      tools: tools.declarations(),
      launchDirectory: '/project',
    })
    const settled = await settle({ threadId, signal: new AbortController().signal })

    expect(settled).toEqual({})
    expect(seenByGuard).toEqual([{ path: 'b.ts' }])
    expect(invoked).toEqual([{ path: 'b.ts' }])
  })

  it('dispatches an allowed call that edited nothing with the input the model asked for', async () => {
    const harness = await openLog()
    const seen: DispatchableCall[] = []
    const { threadId, runId } = await branchWithCalls({
      harness,
      calls: [{ callId: 'call-1', name: 'edit', input: { path: 'a.ts' } }],
    })
    await answerApproval({
      harness,
      threadId,
      runId,
      callId: 'call-1',
      reason: ASK_REASON,
      decision: EDecision.Allow,
    })

    const settle = createSettlePending({ log: harness.log, dispatch: scriptedDispatch({ seen }) })
    await settle({ threadId, signal: new AbortController().signal })

    expect(seen.map((call) => call.input)).toEqual([{ path: 'a.ts' }])
  })

  it('leaves an unanswered call dispatching the input the model asked for', async () => {
    const harness = await openLog()
    const seen: DispatchableCall[] = []
    const { threadId } = await branchWithCalls({
      harness,
      calls: [{ callId: 'call-1', name: 'edit', input: { path: 'a.ts' } }],
    })

    const settle = createSettlePending({ log: harness.log, dispatch: scriptedDispatch({ seen }) })
    await settle({ threadId, signal: new AbortController().signal })

    expect(seen.map((call) => call.input)).toEqual([{ path: 'a.ts' }])
  })
})
