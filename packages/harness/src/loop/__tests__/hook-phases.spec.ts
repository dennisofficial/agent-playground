import { afterEach, describe, expect, it } from 'bun:test'
import type { MockLanguageModelV4 } from 'ai/test'

import { z } from 'zod'

import {
  defaultRules,
  EStage,
  EToolEffect,
  MINIMAL_PREAMBLE,
  type AfterTurn,
  type BeforeRequest,
  type BeforeStep,
  type Message,
  type OnChunk,
  type ToolDefinition,
} from '@dltech/atlas-core'

import { buildHarness, createTurnRunner, ETurnStatus, type AtlasHarness, type TurnRunner } from '..'
import { createDeltaChannel, createPublishingTurnRunner, type ChannelSignal } from '../../channel'
import { createHookRegistry, type HookRegistry } from '../../hooks/registry'
import { interruptibleModel } from '../../model/testing/interruptible-model'
import { scriptedModel, type ScriptedStep } from '../../model/testing/scripted-model'
import { createDispatch } from '../../tools/dispatch'
import { createToolRegistry } from '../../tools/registry'
import { createTempDatabase, type TempDatabase } from './temp-database'

const opened: { harness: AtlasHarness; temp: TempDatabase }[] = []

afterEach(async () => {
  for (const entry of opened.splice(0)) {
    await entry.harness.close()
    entry.temp.discard()
  }
})

const touchTool: ToolDefinition = {
  name: 'touch',
  description: 'do nothing at all',
  effect: EToolEffect.Read,
  inputSchema: z.object({}),
  invoke: async () => ({ ok: true, output: 'touched', modelText: 'touched' }),
}

async function openHooked(args: {
  script: readonly ScriptedStep[]
  hooks: HookRegistry
  withTools?: boolean
}): Promise<{
  runner: TurnRunner
  harness: AtlasHarness
  model: MockLanguageModelV4
}> {
  const temp = createTempDatabase()
  const model = scriptedModel({ script: args.script })
  const harness = await buildHarness({ databaseUrl: temp.databaseUrl, model, hooks: args.hooks })
  opened.push({ harness, temp })

  const tools = createToolRegistry([touchTool])

  return {
    harness,
    model,
    runner: createTurnRunner({
      log: harness.log,
      model: harness.model,
      ids: harness.ids,
      rules: defaultRules(),
      hooks: args.hooks,
      ...(args.withTools === true
        ? {
            tools: tools.declarations(),
            dispatch: createDispatch({ registry: tools, hooks: args.hooks }),
          }
        : {}),
    }),
  }
}

const nudging = (text: string): AfterTurn => async () => [{ type: 'nudge', text, lifetimeSteps: 1 }]

const publishedDeltas = (signals: readonly ChannelSignal[]): string[] =>
  signals.flatMap((signal) =>
    signal.type === 'chunk' && signal.chunk.type === 'text-delta' ? [signal.chunk.text] : [],
  )

describe('BeforeStep', () => {
  it('rewrites the assembled prompt the model is then sent', async () => {
    const insistOnBrevity: BeforeStep = async (assembled) => ({
      ...assembled,
      system: [...assembled.system, { text: 'Answer in one word.' }],
    })

    const { runner, harness, model } = await openHooked({
      script: [{ text: 'auth' }],
      hooks: createHookRegistry({
        beforeStep: [{ name: 'insistOnBrevity', order: { stage: EStage.Policy, nudge: 0 }, run: insistOnBrevity }],
      }),
    })
    const branch = await harness.branches.create({})

    const outcome = await runner.say({ branchId: branch.id, text: 'what changed?' })

    expect(outcome.status).toBe(ETurnStatus.Completed)
    expect(model.doStreamCalls[0]?.prompt.slice(0, 2)).toEqual([
      { role: 'system', content: MINIMAL_PREAMBLE },
      { role: 'system', content: 'Answer in one word.' },
    ])
  })

  it('is checked by exchangeFaults, so a rewrite the provider would reject fails the turn unsent', async () => {
    const blankUserTurn: Message = { role: 'user', content: [{ type: 'text', text: '' }] }
    const blankEveryText: BeforeStep = async (assembled) => ({
      ...assembled,
      messages: assembled.messages.map((entry) => ({ ...entry, message: blankUserTurn })),
    })

    const { runner, harness, model } = await openHooked({
      script: [{ text: 'unreachable' }],
      hooks: createHookRegistry({
        beforeStep: [{ name: 'blankEveryText', order: { stage: EStage.Policy, nudge: 0 }, run: blankEveryText }],
      }),
    })
    const branch = await harness.branches.create({})

    const outcome = await runner.say({ branchId: branch.id, text: 'what changed?' })

    expect(outcome.status).toBe(ETurnStatus.Failed)
    expect(outcome.status === ETurnStatus.Failed ? outcome.message : '').toMatch(/text block holding no text/)
    expect(model.doStreamCalls).toHaveLength(0)
  })
})

describe('BeforeRequest', () => {
  it('rewrites what is sent and leaves no trace in the log at all', async () => {
    const shout: BeforeRequest = async (prompt) => ({
      ...prompt,
      instructions: [...prompt.instructions, { text: 'SHOUT' }],
    })

    const { runner, harness, model } = await openHooked({
      script: [{ text: 'AUTH' }],
      hooks: createHookRegistry({
        beforeRequest: [{ name: 'shout', order: { stage: EStage.Policy, nudge: 0 }, run: shout }],
      }),
    })
    const branch = await harness.branches.create({})

    await runner.say({ branchId: branch.id, text: 'what changed?' })

    expect(model.doStreamCalls[0]?.prompt.slice(0, 2)).toEqual([
      { role: 'system', content: MINIMAL_PREAMBLE },
      { role: 'system', content: 'SHOUT' },
    ])
    const events = await harness.log.read({ branchId: branch.id })
    expect(events.map((event) => event.type)).toEqual(['user-said', 'assistant-said'])
  })
})

describe('AfterTurn', () => {
  it('appends what its hooks return, in stage order, once the turn has completed', async () => {
    const { runner, harness } = await openHooked({
      script: [{ text: 'auth' }],
      hooks: createHookRegistry({
        afterTurn: [
          { name: 'observed', order: { stage: EStage.Observe, nudge: 0 }, run: nudging('observed') },
          { name: 'guarded', order: { stage: EStage.Guard, nudge: 0 }, run: nudging('guarded') },
        ],
      }),
    })
    const branch = await harness.branches.create({})

    await runner.say({ branchId: branch.id, text: 'what changed?' })

    const events = await harness.log.read({ branchId: branch.id })
    expect(events.map((event) => event.type)).toEqual(['user-said', 'assistant-said', 'nudge', 'nudge'])
    expect(events.flatMap((event) => (event.type === 'nudge' ? [event.text] : []))).toEqual([
      'guarded',
      'observed',
    ])
  })

  it('runs once per turn, not once per model step, so a tool round trip does not double it', async () => {
    const { runner, harness } = await openHooked({
      script: [{ text: 'looking', calls: [{ callId: 'call-1', name: 'touch', input: {} }] }, { text: 'auth' }],
      withTools: true,
      hooks: createHookRegistry({
        afterTurn: [{ name: 'observed', order: { stage: EStage.Observe, nudge: 0 }, run: nudging('observed') }],
      }),
    })
    const branch = await harness.branches.create({})

    await runner.say({ branchId: branch.id, text: 'what changed?' })

    const events = await harness.log.read({ branchId: branch.id })
    expect(events.filter((event) => event.type === 'nudge')).toHaveLength(1)
    expect(events.at(-1)?.type).toBe('nudge')
  })
})

describe('OnChunk against the delta channel', () => {
  it('composes with the publisher rather than replacing it: kept deltas still stream, dropped ones do not', async () => {
    const redact: OnChunk = async (chunk) => {
      if (chunk.type === 'text-delta' && chunk.text.includes('sk-')) return null
      return chunk
    }

    const hooks = createHookRegistry({
      onChunk: [{ name: 'secret-redaction', order: { stage: EStage.Guard, nudge: 0 }, run: redact }],
    })

    const temp = createTempDatabase()
    const harness = await buildHarness({
      databaseUrl: temp.databaseUrl,
      model: interruptibleModel({ head: 'auth and ', tail: 'sk-leak', chunkDelayInMs: 0 }),
      hooks,
    })
    opened.push({ harness, temp })

    const channel = createDeltaChannel()
    const seen: ChannelSignal[] = []
    const branch = await harness.branches.create({})
    channel.subscribe({ branchId: branch.id, listener: (signal) => void seen.push(signal) })

    const runner = createPublishingTurnRunner({
      channel,
      deps: { log: harness.log, model: harness.model, ids: harness.ids, rules: defaultRules(), hooks },
    })

    const outcome = await runner.say({ branchId: branch.id, text: 'what changed?' })

    expect(outcome.status).toBe(ETurnStatus.Completed)
    expect(publishedDeltas(seen)).toEqual(['auth and '])
    expect(seen.some((signal) => signal.type === 'step-started')).toBe(true)
  })
})
