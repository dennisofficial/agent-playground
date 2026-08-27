import { afterEach, describe, expect, it } from 'bun:test'
import { z } from 'zod'

import {
  EToolEffect,
  toCallId,
  type BranchId,
  type EventDraft,
  type ToolDeclaration,
} from '@dltech/atlas-core'

import { scriptedModel } from '../../model/testing/scripted-model'
import { ToolDispatcher, type DispatchableCall } from '../../tools/dispatch'
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

const declaring = (args: { name: string; effect: EToolEffect; safe: boolean }): ToolDeclaration => ({
  name: args.name,
  description: `the ${args.name} tool`,
  effect: args.effect,
  inputSchema: z.object({}).loose(),
  ...(args.safe ? { isConcurrencySafe: () => true } : {}),
})

const TOOLS: readonly ToolDeclaration[] = [
  declaring({ name: 'read', effect: EToolEffect.Read, safe: true }),
  declaring({ name: 'grep', effect: EToolEffect.Read, safe: true }),
  declaring({ name: 'write', effect: EToolEffect.Write, safe: false }),
  declaring({ name: 'bash', effect: EToolEffect.Destructive, safe: false }),
]

async function branchWithCalls(args: {
  harness: AtlasHarness
  calls: readonly { callId: string; name: string }[]
}): Promise<BranchId> {
  const branch = await args.harness.branches.create({})
  await args.harness.log.append({
    branchId: branch.id,
    runId: args.harness.ids.nextRunId(),
    drafts: [
      { type: 'user-said', text: 'go' },
      { type: 'assistant-said', parts: [{ type: 'text', text: 'working' }] },
      ...args.calls.map(
        (call, ordinal): EventDraft => ({
          type: 'tool-called',
          callId: toCallId(call.callId),
          name: call.name,
          input: {},
          ordinal,
        }),
      ),
    ],
  })
  return branch.id
}

type Trace = { started: string[]; finished: string[]; peakInFlight: number }

class TracingDispatcher extends ToolDispatcher {
  private inFlight = 0

  constructor(
    private readonly args: {
      trace: Trace
      holdFor?: (call: DispatchableCall) => number
      draftsFor?: (call: DispatchableCall) => readonly EventDraft[]
    },
  ) {
    super()
  }

  async dispatch({ call }: { call: DispatchableCall; signal: AbortSignal }): Promise<readonly EventDraft[]> {
    const { trace } = this.args
    trace.started.push(String(call.callId))
    this.inFlight += 1
    trace.peakInFlight = Math.max(trace.peakInFlight, this.inFlight)

    await Bun.sleep(this.args.holdFor?.(call) ?? 20)

    this.inFlight -= 1
    trace.finished.push(String(call.callId))

    return (
      this.args.draftsFor?.(call) ?? [
        { type: 'tool-result', callId: call.callId, name: call.name, output: 'done', modelText: 'done' },
      ]
    )
  }
}

const tracingDispatch = (args: {
  trace: Trace
  holdFor?: (call: DispatchableCall) => number
  draftsFor?: (call: DispatchableCall) => readonly EventDraft[]
}): ToolDispatcher => new TracingDispatcher(args)

const freshTrace = (): Trace => ({ started: [], finished: [], peakInFlight: 0 })

const resultOrder = async (harness: AtlasHarness, branchId: BranchId): Promise<string[]> =>
  (await harness.log.read({ branchId }))
    .filter((event) => event.type === 'tool-result')
    .map((event) => (event.type === 'tool-result' ? String(event.callId) : ''))

describe('settling a step whose calls may share a batch', () => {
  it('runs consecutive read-only calls at once rather than one after another', async () => {
    const harness = await openLog()
    const branchId = await branchWithCalls({
      harness,
      calls: [
        { callId: 'call-1', name: 'read' },
        { callId: 'call-2', name: 'read' },
        { callId: 'call-3', name: 'grep' },
      ],
    })
    const trace = freshTrace()
    const settle = createSettlePending({
      log: harness.log,
      dispatch: tracingDispatch({ trace }),
      tools: TOOLS,
    })

    await settle({ branchId, signal: new AbortController().signal })

    expect(trace.peakInFlight).toBe(3)
    expect(await resultOrder(harness, branchId)).toEqual(['call-1', 'call-2', 'call-3'])
  })

  it('appends results in call order even when they finish out of order', async () => {
    const harness = await openLog()
    const branchId = await branchWithCalls({
      harness,
      calls: [
        { callId: 'call-slow', name: 'read' },
        { callId: 'call-fast', name: 'read' },
      ],
    })
    const trace = freshTrace()
    const settle = createSettlePending({
      log: harness.log,
      dispatch: tracingDispatch({
        trace,
        holdFor: (call) => (call.callId === toCallId('call-slow') ? 120 : 10),
      }),
      tools: TOOLS,
    })

    await settle({ branchId, signal: new AbortController().signal })

    expect(trace.finished).toEqual(['call-fast', 'call-slow'])
    expect(await resultOrder(harness, branchId)).toEqual(['call-slow', 'call-fast'])
  })

  it('keeps a call that changes the world to itself', async () => {
    const harness = await openLog()
    const branchId = await branchWithCalls({
      harness,
      calls: [
        { callId: 'call-1', name: 'write' },
        { callId: 'call-2', name: 'write' },
      ],
    })
    const trace = freshTrace()
    const settle = createSettlePending({
      log: harness.log,
      dispatch: tracingDispatch({ trace }),
      tools: TOOLS,
    })

    await settle({ branchId, signal: new AbortController().signal })

    expect(trace.peakInFlight).toBe(1)
    expect(trace.finished).toEqual(['call-1', 'call-2'])
  })

  it('treats an unsafe call as a barrier the reads either side do not cross', async () => {
    const harness = await openLog()
    const branchId = await branchWithCalls({
      harness,
      calls: [
        { callId: 'read-a', name: 'read' },
        { callId: 'read-b', name: 'read' },
        { callId: 'the-write', name: 'write' },
        { callId: 'read-c', name: 'read' },
      ],
    })
    const trace = freshTrace()
    const settle = createSettlePending({
      log: harness.log,
      dispatch: tracingDispatch({ trace }),
      tools: TOOLS,
    })

    await settle({ branchId, signal: new AbortController().signal })

    expect(trace.peakInFlight).toBe(2)
    expect(trace.finished.indexOf('the-write')).toBeGreaterThan(trace.finished.indexOf('read-b'))
    expect(trace.finished.indexOf('read-c')).toBeGreaterThan(trace.finished.indexOf('the-write'))
  })

  it('settles one at a time when it knows nothing about the tools', async () => {
    const harness = await openLog()
    const branchId = await branchWithCalls({
      harness,
      calls: [
        { callId: 'call-1', name: 'read' },
        { callId: 'call-2', name: 'read' },
      ],
    })
    const trace = freshTrace()
    const settle = createSettlePending({ log: harness.log, dispatch: tracingDispatch({ trace }) })

    await settle({ branchId, signal: new AbortController().signal })

    expect(trace.peakInFlight).toBe(1)
  })

  it('runs every safe call of a step at once, with no cap to open a second batch', async () => {
    const harness = await openLog()
    const branchId = await branchWithCalls({
      harness,
      calls: Array.from({ length: 24 }, (_, index) => ({ callId: `call-${index}`, name: 'read' })),
    })
    const trace = freshTrace()
    const settle = createSettlePending({
      log: harness.log,
      dispatch: tracingDispatch({ trace }),
      tools: TOOLS,
    })

    await settle({ branchId, signal: new AbortController().signal })

    expect(trace.peakInFlight).toBe(24)
    expect(await resultOrder(harness, branchId)).toHaveLength(24)
  })

  it('pauses at the first approval in call order, keeping the results its batch-mates produced', async () => {
    const harness = await openLog()
    const branchId = await branchWithCalls({
      harness,
      calls: [
        { callId: 'call-1', name: 'read' },
        { callId: 'call-asks', name: 'read' },
        { callId: 'call-3', name: 'read' },
      ],
    })
    const trace = freshTrace()
    const settle = createSettlePending({
      log: harness.log,
      dispatch: tracingDispatch({
        trace,
        draftsFor: (call) =>
          call.callId === toCallId('call-asks')
            ? [{ type: 'approval-requested', callId: call.callId, reason: 'a human should look' }]
            : [{ type: 'tool-result', callId: call.callId, name: call.name, output: 'ok', modelText: 'ok' }],
      }),
      tools: TOOLS,
    })

    const settled = await settle({ branchId, signal: new AbortController().signal })

    expect(settled).toEqual({ paused: { callId: toCallId('call-asks'), reason: 'a human should look' } })
    expect(await resultOrder(harness, branchId)).toEqual(['call-1', 'call-3'])
  })

  it('stops before the next batch once the signal is aborted', async () => {
    const harness = await openLog()
    const branchId = await branchWithCalls({
      harness,
      calls: [
        { callId: 'call-write', name: 'write' },
        { callId: 'call-after', name: 'write' },
      ],
    })
    const controller = new AbortController()
    const trace = freshTrace()
    const settle = createSettlePending({
      log: harness.log,
      dispatch: tracingDispatch({
        trace,
        draftsFor: (call) => {
          controller.abort()
          return [{ type: 'tool-result', callId: call.callId, name: call.name, output: 'ok', modelText: 'ok' }]
        },
      }),
      tools: TOOLS,
    })

    await settle({ branchId, signal: controller.signal })

    expect(trace.started).toEqual(['call-write'])
  })

  it('stamps every result of a batch with the run that emitted its own call', async () => {
    const harness = await openLog()
    const branch = await harness.branches.create({})
    const firstRun = harness.ids.nextRunId()
    await harness.log.append({
      branchId: branch.id,
      runId: firstRun,
      drafts: [
        { type: 'user-said', text: 'go' },
        { type: 'assistant-said', parts: [{ type: 'text', text: 'working' }] },
        { type: 'tool-called', callId: toCallId('call-1'), name: 'read', input: {}, ordinal: 0 },
      ],
    })
    const secondRun = harness.ids.nextRunId()
    await harness.log.append({
      branchId: branch.id,
      runId: secondRun,
      drafts: [{ type: 'tool-called', callId: toCallId('call-2'), name: 'read', input: {}, ordinal: 1 }],
    })
    const settle = createSettlePending({
      log: harness.log,
      dispatch: tracingDispatch({ trace: freshTrace() }),
      tools: TOOLS,
    })

    await settle({ branchId: branch.id, signal: new AbortController().signal })

    const stamped = new Map(
      (await harness.log.read({ branchId: branch.id }))
        .filter((event) => event.type === 'tool-result')
        .map((event) => [event.type === 'tool-result' ? String(event.callId) : '', event.runId]),
    )
    expect(stamped.get('call-1')).toBe(firstRun)
    expect(stamped.get('call-2')).toBe(secondRun)
  })
})
