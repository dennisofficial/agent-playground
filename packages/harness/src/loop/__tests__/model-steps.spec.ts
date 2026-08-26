import { afterEach, describe, expect, it } from 'bun:test'
import type { MockLanguageModelV4 } from 'ai/test'
import { z } from 'zod'

import { defaultRules, defineRule, EToolEffect, type ToolDefinition } from '@dltech/atlas-core'

import { buildHarness, createTurnRunner, ETurnStatus, type AtlasHarness, type TurnRunner } from '..'
import { scriptedModel, type ScriptedStep } from '../../model/testing/scripted-model'
import { createHookRegistry } from '../../hooks/registry'
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

async function openBudgeted(args: { maxSteps: number; script: readonly ScriptedStep[] }): Promise<{
  runner: TurnRunner
  harness: AtlasHarness
  model: MockLanguageModelV4
  steps: number[]
}> {
  const temp = createTempDatabase()
  const model = scriptedModel({ script: args.script })
  const harness = await buildHarness({ databaseUrl: temp.databaseUrl, model })
  opened.push({ harness, temp })

  const registry = createToolRegistry([touchTool])
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
    runner: createTurnRunner({
      log: harness.log,
      model: harness.model,
      ids: harness.ids,
      rules: [...defaultRules(), recordStep],
      tools: registry.declarations(),
      dispatch: createDispatch({ registry, hooks: createHookRegistry({}) }),
      maxSteps: args.maxSteps,
    }),
  }
}

describe('the step ceiling a turn is promised', () => {
  it('spends the budget on model steps alone, so settling a tool call costs nothing', async () => {
    const { runner, harness, model } = await openBudgeted({ maxSteps: 4, script: callingSteps(6) })
    const branch = await harness.branches.create({})

    const outcome = await runner.say({ branchId: branch.id, text: 'touch things' })

    expect(outcome.status).toBe(ETurnStatus.Exhausted)
    expect(model.doStreamCalls).toHaveLength(4)
  })

  it('hands rules the index of the model step, not of the loop iteration', async () => {
    const { runner, harness, steps } = await openBudgeted({ maxSteps: 3, script: callingSteps(5) })
    const branch = await harness.branches.create({})

    await runner.say({ branchId: branch.id, text: 'touch things' })

    expect(steps).toEqual([0, 1, 2])
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

    const runner = createTurnRunner({
      log: harness.log,
      model: harness.model,
      ids: harness.ids,
      rules: [...defaultRules(), speakOutOfTurn],
    })
    const branch = await harness.branches.create({})

    const outcome = await runner.say({ branchId: branch.id, text: 'what changed?' })

    expect(model.doStreamCalls).toHaveLength(0)
    expect(outcome.status).toBe(ETurnStatus.Failed)
    const events = await harness.log.read({ branchId: branch.id })
    const said = events[0]
    expect(outcome.status === ETurnStatus.Failed ? outcome.message : '').toContain(said?.id ?? 'no event')
    expect(outcome.status === ETurnStatus.Failed ? outcome.message : '').toMatch(/first message must be the user/)
  })

  it('sends a real tool exchange to the model rather than faulting on its own projection', async () => {
    const { runner, harness, model } = await openBudgeted({
      maxSteps: 4,
      script: [callingStep(1), { text: 'touched it' }],
    })
    const branch = await harness.branches.create({})

    const outcome = await runner.say({ branchId: branch.id, text: 'touch things' })

    expect(outcome.status).toBe(ETurnStatus.Completed)
    expect(model.doStreamCalls).toHaveLength(2)
  })
})
