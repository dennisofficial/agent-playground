import { afterEach, describe, expect, it } from 'bun:test'
import type { MockLanguageModelV4 } from 'ai/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

import { defaultPipeline, EToolEffect, MINIMAL_PREAMBLE, toCallId, type ToolDefinition } from '@dltech/atlas-core'

import { buildHarness, createTurnRunner, ETurnStatus, type AtlasHarness, type TurnRunner } from '..'
import { scriptedModel, type ScriptedStep } from '../../model/testing/scripted-model'
import { createHookRegistry } from '../../hooks/registry'
import { createDispatch, type Dispatch } from '../../tools/dispatch'
import { createToolRegistry } from '../../tools/registry'
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

const writeToolInput = z.object({ path: z.string(), content: z.string() })

function writeToolIn(root: string): ToolDefinition {
  return {
    name: 'write',
    description: 'write a file',
    effect: EToolEffect.Write,
    inputSchema: writeToolInput,
    invoke: async ({ input }) => {
      const parsed = writeToolInput.safeParse(input)
      if (!parsed.success) return { ok: false, reason: 'write needs a path and content' }

      await Bun.write(join(root, parsed.data.path), parsed.data.content)
      return { ok: true, output: { path: parsed.data.path }, modelText: `wrote ${parsed.data.path}` }
    },
  }
}

describe('a turn that settles its own tool call', () => {
  it('runs a real tool against the workspace and completes on the next step', async () => {
    const root = mkdtempSync(join(tmpdir(), 'atlas-workspace-'))
    const temp = createTempDatabase()
    const harness = await buildHarness({
      databaseUrl: temp.databaseUrl,
      model: scriptedModel({
        script: [
          {
            text: 'writing it',
            calls: [{ callId: 'call-1', name: 'write', input: { path: 'notes.md', content: '# hello' } }],
          },
          { text: 'written' },
        ],
      }),
    })
    opened.push({ harness, temp })

    const registry = createToolRegistry([writeToolIn(root)])
    const runner = createTurnRunner({
      log: harness.log,
      model: harness.model,
      ids: harness.ids,
      assembly: defaultPipeline(),
      tools: registry.declarations(),
      dispatch: createDispatch({ registry, hooks: createHookRegistry({}) }),
    })
    const branch = await harness.branches.create({})

    const outcome = await runner.say({ branchId: branch.id, text: 'write notes.md' })

    expect(outcome.status).toBe(ETurnStatus.Completed)
    const events = await harness.log.read({ branchId: branch.id })
    expect(events.map((event) => event.type)).toEqual([
      'user-said',
      'assistant-said',
      'tool-called',
      'tool-result',
      'assistant-said',
    ])
    expect(await Bun.file(join(root, 'notes.md')).text()).toBe('# hello')
    rmSync(root, { recursive: true, force: true })
  })
})

async function runnerDispatchingWith(dispatch: Dispatch): Promise<{ runner: TurnRunner; harness: AtlasHarness }> {
  const temp = createTempDatabase()
  const harness = await buildHarness({
    databaseUrl: temp.databaseUrl,
    model: scriptedModel({
      script: [{ text: 'reading', calls: [{ callId: 'call-1', name: 'read', input: { path: 'a.ts' } }] }, { text: 'read it' }],
    }),
  })
  opened.push({ harness, temp })

  return {
    harness,
    runner: createTurnRunner({
      log: harness.log,
      model: harness.model,
      ids: harness.ids,
      assembly: defaultPipeline(),
      dispatch,
    }),
  }
}

describe('a turn whose settlement does not finish', () => {
  it('pauses on the call the settlement asked a human about', async () => {
    const { runner, harness } = await runnerDispatchingWith(async ({ call }) => [
      { type: 'approval-requested', callId: call.callId, reason: 'read needs a human' },
    ])
    const branch = await harness.branches.create({})

    const outcome = await runner.say({ branchId: branch.id, text: 'read a.ts' })

    expect(outcome.status).toBe(ETurnStatus.Paused)
    expect(outcome.status === ETurnStatus.Paused ? outcome.reason : '').toBe('read needs a human')
    expect(outcome.status === ETurnStatus.Paused ? outcome.callId : '').toBe(toCallId('call-1'))
  })

  it('reports an interruption rather than spinning when the settlement was cut short', async () => {
    const controller = new AbortController()
    const { runner, harness } = await runnerDispatchingWith(async ({ call }) => {
      controller.abort()
      return [{ type: 'tool-result', callId: call.callId, name: call.name, output: 'read', modelText: 'read' }]
    })
    const branch = await harness.branches.create({})

    const outcome = await runner.say({ branchId: branch.id, text: 'read a.ts', signal: controller.signal })

    expect(outcome.status).toBe(ETurnStatus.Interrupted)
  })
})
