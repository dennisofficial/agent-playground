import { afterEach, describe, expect, it } from 'bun:test'
import type { MockLanguageModelV4 } from 'ai/test'
import { z } from 'zod'

import { EToolEffect, MINIMAL_PREAMBLE, toCallId } from '@dltech/atlas-core'

import { buildHarness, ETurnStatus, type AtlasHarness } from '..'
import { scriptedModel, type ScriptedStep } from '../../model/testing/scripted-model'
import { createTempDatabase, type TempDatabase } from './temp-database'

const opened: { harness: AtlasHarness; temp: TempDatabase }[] = []

async function open(script: readonly ScriptedStep[]): Promise<AtlasHarness> {
  return (await openWithModel(scriptedModel({ script }))).harness
}

async function openWithModel(model: MockLanguageModelV4): Promise<{ harness: AtlasHarness; model: MockLanguageModelV4 }> {
  const temp = createTempDatabase()
  const harness = await buildHarness({ databaseUrl: temp.databaseUrl, model })
  opened.push({ harness, temp })
  return { harness, model }
}

afterEach(async () => {
  for (const entry of opened.splice(0)) {
    await entry.harness.close()
    entry.temp.discard()
  }
})

describe('a turn over a real log', () => {
  it('records the user turn and the assistant reply in order', async () => {
    const harness = await open([{ text: 'two files changed' }])
    const branch = await harness.branches.create({})

    const outcome = await harness.runner.say({ branchId: branch.id, text: 'what changed?' })

    expect(outcome.status).toBe(ETurnStatus.Completed)
    const events = await harness.log.read({ branchId: branch.id })
    expect(events.map((event) => event.type)).toEqual(['user-said', 'assistant-said'])
  })

  it('appends one assistant event per model step holding every block it streamed', async () => {
    const harness = await open([
      { reasoning: { text: 'two files touched', signature: 'sig-abc' }, text: 'auth and the router' },
    ])
    const branch = await harness.branches.create({})

    await harness.runner.say({ branchId: branch.id, text: 'what changed?' })

    const events = await harness.log.read({ branchId: branch.id })
    const assistantTurns = events.filter((event) => event.type === 'assistant-said')
    expect(assistantTurns).toHaveLength(1)
    expect(assistantTurns[0]?.type === 'assistant-said' ? assistantTurns[0].parts : []).toEqual([
      { type: 'reasoning', text: 'two files touched', providerOptions: { anthropic: { signature: 'sig-abc' } } },
      { type: 'text', text: 'auth and the router' },
    ])
  })

  it('hands the system preamble to the provider as an instruction, not as a message', async () => {
    const { harness, model } = await openWithModel(scriptedModel({ script: [{ text: 'auth and the router' }] }))
    const branch = await harness.branches.create({})

    await harness.runner.say({ branchId: branch.id, text: 'what changed?' })

    const prompt = model.doStreamCalls[0]?.prompt ?? []
    expect(prompt[0]).toEqual({ role: 'system', content: MINIMAL_PREAMBLE })
    expect(prompt.slice(1).map((message) => message.role)).toEqual(['user'])
  })

  it('reports a model error as a failure naming it, and appends no assistant turn', async () => {
    const harness = await open([{ error: 'overloaded_error' }])
    const branch = await harness.branches.create({})

    const outcome = await harness.runner.say({ branchId: branch.id, text: 'what changed?' })

    expect(outcome.status).toBe(ETurnStatus.Failed)
    expect(outcome.status === ETurnStatus.Failed ? outcome.message : '').toMatch(/overloaded_error/)
    const events = await harness.log.read({ branchId: branch.id })
    expect(events.map((event) => event.type)).toEqual(['user-said'])
  })
})

describe('position derived from the log', () => {
  it('does not ask the model anything on a branch that holds nothing', async () => {
    const { harness, model } = await openWithModel(scriptedModel({ script: [{ text: 'unreachable' }] }))
    const branch = await harness.branches.create({})

    const outcome = await harness.runner.runTurn({ branchId: branch.id })

    expect(outcome.status).toBe(ETurnStatus.Idle)
    expect(model.doStreamCalls).toHaveLength(0)
  })

  it('leaves an already answered branch alone rather than re-asking', async () => {
    const { harness, model } = await openWithModel(scriptedModel({ script: [{ text: 'auth and the router' }] }))
    const branch = await harness.branches.create({})
    await harness.runner.say({ branchId: branch.id, text: 'what changed?' })

    const outcome = await harness.runner.runTurn({ branchId: branch.id })

    expect(outcome.status).toBe(ETurnStatus.Idle)
    expect(model.doStreamCalls).toHaveLength(1)
    const events = await harness.log.read({ branchId: branch.id })
    expect(events.map((event) => event.type)).toEqual(['user-said', 'assistant-said'])
  })

  it('answers a user turn the previous process never got to', async () => {
    const { harness, model } = await openWithModel(scriptedModel({ script: [{ text: 'answering late' }] }))
    const branch = await harness.branches.create({})
    await harness.log.append({
      branchId: branch.id,
      runId: harness.ids.nextRunId(),
      drafts: [{ type: 'user-said', text: 'what changed?' }],
    })

    const outcome = await harness.runner.runTurn({ branchId: branch.id })

    expect(outcome.status).toBe(ETurnStatus.Completed)
    expect(model.doStreamCalls).toHaveLength(1)
    const events = await harness.log.read({ branchId: branch.id })
    expect(events.map((event) => event.type)).toEqual(['user-said', 'assistant-said'])
  })

  it('records a tool call nothing can settle and pauses on it', async () => {
    const temp = createTempDatabase()
    const model = scriptedModel({
      script: [{ text: 'reading', calls: [{ callId: 'call-1', name: 'read_file', input: { path: 'a.ts' } }] }],
    })
    const harness = await buildHarness({
      databaseUrl: temp.databaseUrl,
      model,
      tools: [
        {
          name: 'read_file',
          description: 'read a file',
          effect: EToolEffect.Read,
          inputSchema: z.object({ path: z.string() }),
        },
      ],
    })
    opened.push({ harness, temp })
    const branch = await harness.branches.create({})

    const outcome = await harness.runner.say({ branchId: branch.id, text: 'read a.ts' })

    expect(outcome.status).toBe(ETurnStatus.Paused)
    expect(outcome.status === ETurnStatus.Paused ? outcome.callId : '').toBe(toCallId('call-1'))
    const events = await harness.log.read({ branchId: branch.id })
    expect(events.map((event) => event.type)).toEqual(['user-said', 'assistant-said', 'tool-called'])
  })
})
