import { afterEach, describe, expect, it } from 'bun:test'
import { z } from 'zod'

import {
  defaultPipeline,
  DynamicToolSource,
  EMPTY_PROMPT,
  EToolEffect,
  toCallId,
  type EventDraft,
  type ToolDeclaration,
  type ToolDefinition,
} from '@dltech/atlas-core'

import { buildHarness, ETurnStatus, LoopTurnRunner, type AtlasHarness } from '..'
import { HookChain } from '../../hooks/registry'
import { scriptedModel } from '../../model/testing/scripted-model'
import { CompositeToolRegistry } from '../../tools/composite-registry'
import { InMemoryToolRegistry } from '../../tools/registry'
import {
  EApprovalRouting,
  HookedToolDispatcher,
  ToolDispatcher,
  type DispatchableCall,
} from '../../tools/dispatch'
import { createSettlePending } from '../settle-pending'
import { branchWithCalls } from './settle-pending-fixture'
import { createTempDatabase, type TempDatabase } from './temp-database'

const PROJECT_DIRECTORY = '/w'

const opened: { harness: AtlasHarness; temp: TempDatabase }[] = []

afterEach(async () => {
  for (const entry of opened.splice(0)) {
    await entry.harness.close()
    entry.temp.discard()
  }
})

class MutableSource extends DynamicToolSource {
  readonly held: ToolDefinition[] = []

  declarations() {
    return this.held
  }

  find(name: string) {
    return this.held.find((tool) => tool.name === name)
  }
}

describe('a tool that joins while the turn is running', () => {
  it('is offered on the next model step and dispatches through the same registry', async () => {
    const temp = createTempDatabase()
    const model = scriptedModel({
      script: [
        { text: 'touching', calls: [{ callId: 'call-1', name: 'touch', input: {} }] },
        { text: 'reaching late', calls: [{ callId: 'call-2', name: 'late_read', input: {} }] },
        { text: 'done' },
      ],
    })
    const harness = await buildHarness({ databaseUrl: temp.databaseUrl, model })
    opened.push({ harness, temp })

    const source = new MutableSource()
    const invoked: string[] = []
    const lateRead: ToolDefinition = {
      name: 'late_read',
      description: 'a tool that connected mid-turn',
      effect: EToolEffect.Read,
      inputSchema: z.object({}),
      isConcurrencySafe: () => true,
      invoke: async () => {
        invoked.push('late_read')
        return { ok: true, output: 'late', modelText: 'late' }
      },
    }
    const touch: ToolDefinition = {
      name: 'touch',
      description: 'do nothing at all',
      effect: EToolEffect.Read,
      inputSchema: z.object({}),
      invoke: async () => {
        source.held.push(lateRead)
        return { ok: true, output: 'touched', modelText: 'touched' }
      },
    }
    const registry = new CompositeToolRegistry({
      base: new InMemoryToolRegistry([touch]),
      sources: [source],
    })
    const runner = new LoopTurnRunner({
      log: harness.log,
      model: harness.model,
      ids: harness.ids,
      assembly: defaultPipeline({ prompt: () => EMPTY_PROMPT, launchDirectory: PROJECT_DIRECTORY }),
      tools: () => registry.declarations(),
      dispatch: new HookedToolDispatcher({
        approvals: EApprovalRouting.Operator,
        registry,
        hooks: new HookChain({}),
      }),
    })
    const thread = await harness.threads.create({})

    const outcome = await runner.say({ threadId: thread.id, text: 'go' })

    expect(outcome.status).toBe(ETurnStatus.Completed)
    expect(model.doStreamCalls[0]?.tools?.map((tool) => tool.name)).toEqual(['touch'])
    expect(model.doStreamCalls[1]?.tools?.map((tool) => tool.name)).toEqual(['touch', 'late_read'])
    expect(model.doStreamCalls[2]?.tools?.map((tool) => tool.name)).toEqual(['touch', 'late_read'])
    expect(invoked).toEqual(['late_read'])
  })

  it('stops being offered once it leaves, and a call naming it gets the unknown-tool correction', async () => {
    const temp = createTempDatabase()
    const model = scriptedModel({
      script: [
        { text: 'touching', calls: [{ callId: 'call-1', name: 'touch', input: {} }] },
        { text: 'again', calls: [{ callId: 'call-2', name: 'fleeting', input: {} }] },
        { text: 'done' },
      ],
    })
    const harness = await buildHarness({ databaseUrl: temp.databaseUrl, model })
    opened.push({ harness, temp })

    const source = new MutableSource()
    const fleeting: ToolDefinition = {
      name: 'fleeting',
      description: 'a tool that disconnects mid-turn',
      effect: EToolEffect.Read,
      inputSchema: z.object({}),
      invoke: async () => ({ ok: true, output: 'ran', modelText: 'ran' }),
    }
    source.held.push(fleeting)
    const touch: ToolDefinition = {
      name: 'touch',
      description: 'do nothing at all',
      effect: EToolEffect.Read,
      inputSchema: z.object({}),
      invoke: async () => {
        source.held.splice(0)
        return { ok: true, output: 'touched', modelText: 'touched' }
      },
    }
    const registry = new CompositeToolRegistry({
      base: new InMemoryToolRegistry([touch]),
      sources: [source],
    })
    const runner = new LoopTurnRunner({
      log: harness.log,
      model: harness.model,
      ids: harness.ids,
      assembly: defaultPipeline({ prompt: () => EMPTY_PROMPT, launchDirectory: PROJECT_DIRECTORY }),
      tools: () => registry.declarations(),
      dispatch: new HookedToolDispatcher({
        approvals: EApprovalRouting.Operator,
        registry,
        hooks: new HookChain({}),
      }),
    })
    const thread = await harness.threads.create({})

    const outcome = await runner.say({ threadId: thread.id, text: 'go' })

    expect(outcome.status).toBe(ETurnStatus.Completed)
    expect(model.doStreamCalls[0]?.tools?.map((tool) => tool.name)).toEqual(['touch', 'fleeting'])
    expect(model.doStreamCalls[1]?.tools?.map((tool) => tool.name)).toEqual(['touch'])

    const events = await harness.log.read({ threadId: thread.id })
    const result = events.find(
      (event) => event.type === 'tool-result' && event.callId === toCallId('call-2'),
    )
    expect(result?.type === 'tool-result' ? result.error?.message : '').toMatch(
      /no tool named "fleeting" is registered/,
    )
  })
})

describe('settling against declarations that arrive late', () => {
  class OverlapDispatcher extends ToolDispatcher {
    inFlight = 0
    peak = 0

    async dispatch({ call }: { call: DispatchableCall }): Promise<readonly EventDraft[]> {
      this.inFlight += 1
      this.peak = Math.max(this.peak, this.inFlight)
      await Bun.sleep(20)
      this.inFlight -= 1
      return [
        { type: 'tool-result', callId: call.callId, name: call.name, output: 'done', modelText: 'done' },
      ]
    }
  }

  it('reads the supplier at settle time, so a safe tool registered after construction batches', async () => {
    const temp = createTempDatabase()
    const harness = await buildHarness({
      databaseUrl: temp.databaseUrl,
      model: scriptedModel({ script: [] }),
    })
    opened.push({ harness, temp })
    const { threadId } = await branchWithCalls({
      harness,
      calls: [
        { callId: 'call-1', name: 'late_read' },
        { callId: 'call-2', name: 'late_read' },
      ],
    })

    let held: readonly ToolDeclaration[] = []
    const dispatcher = new OverlapDispatcher()
    const settle = createSettlePending({
      log: harness.log,
      dispatch: dispatcher,
      tools: () => held,
    })
    held = [
      {
        name: 'late_read',
        description: 'a tool that connected after the runner was built',
        effect: EToolEffect.Read,
        inputSchema: z.object({}),
        isConcurrencySafe: () => true,
      },
    ]

    await settle({ threadId, signal: new AbortController().signal })

    expect(dispatcher.peak).toBe(2)
  })
})
