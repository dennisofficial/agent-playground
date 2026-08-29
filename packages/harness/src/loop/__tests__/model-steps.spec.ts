import { afterEach, describe, expect, it } from 'bun:test'
import type { MockLanguageModelV4 } from 'ai/test'
import { z } from 'zod'

import {
  defaultAnnotators,
  defaultPipeline,
  defaultRules,
  defineRule,
  EMPTY_PROMPT,
  EToolEffect,
  type ToolDefinition,
} from '@dltech/atlas-core'

import { buildHarness, ETurnStatus, LoopTurnRunner, TurnRunner, type AtlasHarness } from '..'
import { scriptedModel, type ScriptedStep } from '../../model/testing/scripted-model'
import { HookChain } from '../../hooks/registry'
import { HookedToolDispatcher } from '../../tools/dispatch'
import { InMemoryToolRegistry } from '../../tools/registry'
import { createTempDatabase, type TempDatabase } from './temp-database'

const PROJECT_DIRECTORY = '/w'

const opened: { harness: AtlasHarness; temp: TempDatabase }[] = []

afterEach(async () => {
  for (const entry of opened.splice(0)) {
    await entry.harness.close()
    entry.temp.discard()
  }
})

const callingStep = (ordinal: number): ScriptedStep => ({
  text: `step ${ordinal}`,
  calls: [{ callId: `call-${ordinal}`, name: 'touch', input: {} }],
})

const touchTool: ToolDefinition = {
  name: 'touch',
  description: 'do nothing at all',
  effect: EToolEffect.Read,
  inputSchema: z.object({}),
  invoke: async () => ({ ok: true, output: 'touched', modelText: 'touched' }),
}

const callingSteps = (count: number): ScriptedStep[] =>
  Array.from({ length: count }, (_, index) => callingStep(index + 1))

async function openScripted(args: { script: readonly ScriptedStep[] }): Promise<{
  runner: TurnRunner
  harness: AtlasHarness
  model: MockLanguageModelV4
  steps: number[]
}> {
  const temp = createTempDatabase()
  const model = scriptedModel({ script: args.script })
  const harness = await buildHarness({ databaseUrl: temp.databaseUrl, model })
  opened.push({ harness, temp })

  const registry = new InMemoryToolRegistry([touchTool])
  const steps: number[] = []
  const recordStep = defineRule({
    name: 'recordStep',
    apply: (input, ctx) => {
      steps.push(ctx.step)
      return input
    },
  })

  return {
    harness,
    model,
    steps,
    runner: new LoopTurnRunner({
      log: harness.log,
      model: harness.model,
      ids: harness.ids,
      assembly: { rules: [...defaultRules({ prompt: () => EMPTY_PROMPT, projectDirectory: PROJECT_DIRECTORY }), recordStep], annotators: defaultAnnotators() },
      tools: registry.declarations(),
      dispatch: new HookedToolDispatcher({ registry, hooks: new HookChain({}) }),
    }),
  }
}

describe('how long a turn is allowed to work', () => {
  it('runs as many model steps as the work takes, with no ceiling to cut it short', async () => {
    const { runner, harness, model } = await openScripted({
      script: [...callingSteps(64), { text: 'touched all of them' }],
    })
    const thread = await harness.threads.create({})

    const outcome = await runner.say({ threadId: thread.id, text: 'touch things' })

    expect(outcome.status).toBe(ETurnStatus.Completed)
    expect(model.doStreamCalls).toHaveLength(65)
  })

  it('hands rules the index of the model step, not of the loop iteration', async () => {
    const { runner, harness, steps } = await openScripted({
      script: [...callingSteps(3), { text: 'touched them' }],
    })
    const thread = await harness.threads.create({})

    await runner.say({ threadId: thread.id, text: 'touch things' })

    expect(steps).toEqual([0, 1, 2, 3])
  })
})

describe('the shape of the prompt the loop is about to send', () => {
  it('fails naming the faulty message and its event rather than letting the provider reject it', async () => {
    const temp = createTempDatabase()
    const model = scriptedModel({ script: [{ text: 'never asked' }] })
    const harness = await buildHarness({ databaseUrl: temp.databaseUrl, model })
    opened.push({ harness, temp })

    const speakOutOfTurn = defineRule({
      name: 'speakOutOfTurn',
      apply: (input, ctx) => {
        const first = ctx.events[0]
        if (first === undefined) return input

        return {
          system: input.system,
          messages: [
            {
              message: { role: 'assistant', content: [{ type: 'text', text: 'the model spoke first' }] },
              origin: { eventId: first.id, seq: first.seq },
            },
          ],
        }
      },
    })

    const runner = new LoopTurnRunner({
      log: harness.log,
      model: harness.model,
      ids: harness.ids,
      assembly: { rules: [...defaultRules({ prompt: () => EMPTY_PROMPT, projectDirectory: PROJECT_DIRECTORY }), speakOutOfTurn], annotators: defaultAnnotators() },
    })
    const thread = await harness.threads.create({})

    const outcome = await runner.say({ threadId: thread.id, text: 'what changed?' })

    expect(model.doStreamCalls).toHaveLength(0)
    expect(outcome.status).toBe(ETurnStatus.Failed)
    const events = await harness.log.read({ threadId: thread.id })
    const said = events[0]
    expect(outcome.status === ETurnStatus.Failed ? outcome.message : '').toContain(said?.id ?? 'no event')
    expect(outcome.status === ETurnStatus.Failed ? outcome.message : '').toMatch(/first message must be the user/)
  })

  it('sends a real tool exchange to the model rather than faulting on its own projection', async () => {
    const { runner, harness, model } = await openScripted({
      script: [callingStep(1), { text: 'touched it' }],
    })
    const thread = await harness.threads.create({})

    const outcome = await runner.say({ threadId: thread.id, text: 'touch things' })

    expect(outcome.status).toBe(ETurnStatus.Completed)
    expect(model.doStreamCalls).toHaveLength(2)
  })
})

describe('a thinking turn whose text block arrives blank', () => {
  it('completes the turn Claude opens a blank text block in, and records only what was said', async () => {
    const { runner, harness, model } = await openScripted({
      script: [
        { reasoning: { text: 'the file needs touching' }, text: '  \n ', calls: [{ callId: 'call-1', name: 'touch', input: {} }] },
        { text: 'touched it' },
      ],
    })
    const thread = await harness.threads.create({})

    const outcome = await runner.say({ threadId: thread.id, text: 'touch things' })

    expect(outcome.status).toBe(ETurnStatus.Completed)
    expect(model.doStreamCalls).toHaveLength(2)
    const events = await harness.log.read({ threadId: thread.id })
    const spoken = events.flatMap((event) =>
      event.type === 'assistant-said' ? [event.parts.map((part) => part.type)] : [],
    )
    expect(spoken).toEqual([['reasoning'], ['text']])
  })

  it('appends no assistant turn at all when the only thing said was blank', async () => {
    const { runner, harness } = await openScripted({
      script: [{ text: '   ', calls: [{ callId: 'call-1', name: 'touch', input: {} }] }, { text: 'touched it' }],
    })
    const thread = await harness.threads.create({})

    const outcome = await runner.say({ threadId: thread.id, text: 'touch things' })

    expect(outcome.status).toBe(ETurnStatus.Completed)
    const events = await harness.log.read({ threadId: thread.id })
    expect(events.map((event) => event.type)).toEqual([
      'user-said',
      'tool-called',
      'tool-result',
      'assistant-said',
    ])
  })
})

describe('a dispatch that settles nothing', () => {
  it('fails naming the stuck call rather than spinning on it forever', async () => {
    const temp = createTempDatabase()
    const model = scriptedModel({ script: [callingStep(1)] })
    const harness = await buildHarness({ databaseUrl: temp.databaseUrl, model })
    opened.push({ harness, temp })

    const registry = new InMemoryToolRegistry([touchTool])
    let dispatched = 0
    const runner = new LoopTurnRunner({
      log: harness.log,
      model: harness.model,
      ids: harness.ids,
      assembly: defaultPipeline({ prompt: () => EMPTY_PROMPT, projectDirectory: PROJECT_DIRECTORY }),
      tools: registry.declarations(),
      dispatch: {
        dispatch: async () => {
          dispatched += 1
          return []
        },
      },
    })
    const thread = await harness.threads.create({})

    const outcome = await runner.say({ threadId: thread.id, text: 'touch things' })

    expect(outcome.status).toBe(ETurnStatus.Failed)
    expect(outcome.status === ETurnStatus.Failed ? outcome.message : '').toContain('touch')
    expect(dispatched).toBe(1)
  })
})
