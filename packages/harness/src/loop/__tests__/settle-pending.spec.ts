import { afterEach, describe, expect, it } from 'bun:test'

import { toCallId, toSnapshotId, type ThreadId, type EventDraft, type RunId } from '@dltech/atlas-core'

import { scriptedModel } from '../../model/testing/scripted-model'
import type { DispatchableCall, ToolDispatcher } from '../../tools/dispatch'
import { buildHarness, type AtlasHarness } from '..'
import { createSettlePending } from '../settle-pending'
import { createTempDatabase, type TempDatabase } from './temp-database'

const opened: { harness: AtlasHarness; temp: TempDatabase }[] = []

afterEach(async () => {
  for (const entry of opened.splice(0)) {
    await entry.harness.close()
    entry.temp.discard()
  }
})

async function openLog(): Promise<AtlasHarness> {
  const temp = createTempDatabase()
  const harness = await buildHarness({ databaseUrl: temp.databaseUrl, model: scriptedModel({ script: [] }) })
  opened.push({ harness, temp })
  return harness
}

async function branchWithCalls(args: {
  harness: AtlasHarness
  calls: readonly { callId: string; name: string; input?: unknown; ordinal?: number }[]
}): Promise<{ threadId: ThreadId; runId: RunId }> {
  const thread = await args.harness.threads.create({})
  const runId = args.harness.ids.nextRunId()
  await args.harness.log.append({
    threadId: thread.id,
    runId,
    drafts: [
      { type: 'user-said', text: 'edit a.ts' },
      { type: 'assistant-said', parts: [{ type: 'text', text: 'editing' }] },
      ...args.calls.map(
        (call, ordinal): EventDraft => ({
          type: 'tool-called',
          callId: toCallId(call.callId),
          name: call.name,
          input: call.input ?? {},
          ordinal: call.ordinal ?? ordinal,
        }),
      ),
    ],
  })

  return { threadId: thread.id, runId }
}

function scriptedDispatch(args: {
  seen: DispatchableCall[]
  draftsFor?: (call: DispatchableCall) => readonly EventDraft[]
}): ToolDispatcher {
  const dispatch = async ({ call }: { call: DispatchableCall }): Promise<readonly EventDraft[]> => {
    args.seen.push(call)
    return (
      args.draftsFor?.(call) ?? [
        { type: 'tool-result', callId: call.callId, name: call.name, output: 'done', modelText: 'done' },
      ]
    )
  }

  return { dispatch }
}

describe('settling the calls a step left pending', () => {
  it('appends what dispatch returns and reports no pause', async () => {
    const harness = await openLog()
    const { threadId } = await branchWithCalls({ harness, calls: [{ callId: 'call-1', name: 'edit' }] })
    const seen: DispatchableCall[] = []
    const settle = createSettlePending({ log: harness.log, dispatch: scriptedDispatch({ seen }) })

    const settled = await settle({ threadId, signal: new AbortController().signal })

    expect(settled).toEqual({})
    expect(seen.map((call) => call.callId)).toEqual([toCallId('call-1')])
    const events = await harness.log.read({ threadId })
    expect(events.map((event) => event.type)).toEqual([
      'user-said',
      'assistant-said',
      'tool-called',
      'tool-result',
    ])
  })

  it('settles every call of the step in ordinal order, whatever order the log holds them in', async () => {
    const harness = await openLog()
    const { threadId } = await branchWithCalls({
      harness,
      calls: [
        { callId: 'call-late', name: 'edit', ordinal: 1 },
        { callId: 'call-early', name: 'read', ordinal: 0 },
      ],
    })
    const seen: DispatchableCall[] = []
    const settle = createSettlePending({ log: harness.log, dispatch: scriptedDispatch({ seen }) })

    await settle({ threadId, signal: new AbortController().signal })

    expect(seen.map((call) => call.callId)).toEqual([toCallId('call-early'), toCallId('call-late')])
  })

  it('stops at an approval request, appends it, and reports the pause', async () => {
    const harness = await openLog()
    const { threadId } = await branchWithCalls({
      harness,
      calls: [
        { callId: 'call-1', name: 'read' },
        { callId: 'call-2', name: 'bash' },
        { callId: 'call-3', name: 'read' },
      ],
    })
    const seen: DispatchableCall[] = []
    const settle = createSettlePending({
      log: harness.log,
      dispatch: scriptedDispatch({
        seen,
        draftsFor: (call) =>
          call.name === 'bash'
            ? [{ type: 'approval-requested', callId: call.callId, reason: 'bash needs a human' }]
            : [{ type: 'tool-result', callId: call.callId, name: call.name, output: 'done', modelText: 'done' }],
      }),
    })

    const settled = await settle({ threadId, signal: new AbortController().signal })

    expect(settled).toEqual({ paused: { callId: toCallId('call-2'), reason: 'bash needs a human' } })
    expect(seen.map((call) => call.callId)).toEqual([toCallId('call-1'), toCallId('call-2')])
    const events = await harness.log.read({ threadId })
    expect(events.map((event) => event.type).slice(-2)).toEqual(['tool-result', 'approval-requested'])
  })

  it('stops before the next call once the signal is aborted, keeping what already ran', async () => {
    const harness = await openLog()
    const { threadId } = await branchWithCalls({
      harness,
      calls: [
        { callId: 'call-1', name: 'read' },
        { callId: 'call-2', name: 'read' },
      ],
    })
    const controller = new AbortController()
    const seen: DispatchableCall[] = []
    const settle = createSettlePending({
      log: harness.log,
      dispatch: scriptedDispatch({
        seen,
        draftsFor: (call) => {
          controller.abort()
          return [{ type: 'tool-result', callId: call.callId, name: call.name, output: 'done', modelText: 'done' }]
        },
      }),
    })

    const settled = await settle({ threadId, signal: controller.signal })

    expect(settled).toEqual({})
    expect(seen.map((call) => call.callId)).toEqual([toCallId('call-1')])
    const events = await harness.log.read({ threadId })
    expect(events.filter((event) => event.type === 'tool-result')).toHaveLength(1)
  })

  it('stamps a result with the run that emitted the call, so a resumed turn logs what an unbroken one would', async () => {
    const harness = await openLog()
    const { threadId, runId: emittingRun } = await branchWithCalls({
      harness,
      calls: [{ callId: 'call-1', name: 'read' }],
    })
    const laterRun = harness.ids.nextRunId()
    await harness.log.append({
      threadId,
      runId: laterRun,
      drafts: [
        { type: 'assistant-said', parts: [{ type: 'text', text: 'and one more' }] },
        { type: 'tool-called', callId: toCallId('call-2'), name: 'read', input: {}, ordinal: 1 },
      ],
    })
    const settle = createSettlePending({ log: harness.log, dispatch: scriptedDispatch({ seen: [] }) })

    await settle({ threadId, signal: new AbortController().signal })

    const events = await harness.log.read({ threadId })
    const stampedBy = new Map(
      events
        .filter((event) => event.type === 'tool-result')
        .map((event) => [event.type === 'tool-result' ? event.callId : '', event.runId]),
    )
    expect(stampedBy.get(toCallId('call-1'))).toBe(emittingRun)
    expect(stampedBy.get(toCallId('call-2'))).toBe(laterRun)
    expect(emittingRun).not.toBe(laterRun)
  })
})

describe('settling a call whose dispatch took a workspace snapshot', () => {
  it('persists the snapshot id, so the world timeline survives a re-read of the log', async () => {
    const harness = await openLog()
    const { threadId } = await branchWithCalls({ harness, calls: [{ callId: 'call-1', name: 'edit' }] })
    const seen: DispatchableCall[] = []
    const settle = createSettlePending({
      log: harness.log,
      dispatch: scriptedDispatch({
        seen,
        draftsFor: (call) => [
          {
            type: 'tool-result',
            callId: call.callId,
            name: call.name,
            output: 'done',
            modelText: 'done',
            snapshotId: toSnapshotId('4b825dc642cb6eb9a060e54bf8d69288fbee4904'),
          },
        ],
      }),
    })

    await settle({ threadId, signal: new AbortController().signal })

    const events = await harness.log.read({ threadId })
    const result = events.find((event) => event.type === 'tool-result')
    expect(result?.type === 'tool-result' ? result.snapshotId : undefined).toBe(
      toSnapshotId('4b825dc642cb6eb9a060e54bf8d69288fbee4904'),
    )
  })
})
