import { afterEach, describe, expect, it } from 'bun:test'
import { z } from 'zod'

import {
  defaultPipeline,
  EImageTier,
  EMPTY_PROMPT,
  EToolEffect,
  type ModelCard,
  type ToolDefinition,
} from '@dltech/atlas-core'

import { buildHarness, LoopTurnRunner, type AtlasHarness } from '..'
import { scriptedModel, type ScriptedStep } from '../../model/testing/scripted-model'
import { HookChain } from '../../hooks/registry'
import { EApprovalRouting, HookedToolDispatcher } from '../../tools/dispatch'
import { InMemoryToolRegistry } from '../../tools/registry'
import { createTempDatabase, type TempDatabase } from './temp-database'

const PROJECT_DIRECTORY = '/w'

const HAIKU_WINDOW = 200_000

const HAIKU_CARD: ModelCard = {
  ref: { providerId: 'anthropic', modelId: 'claude-haiku-4-5' },
  label: 'haiku-4-5',
  api: 'anthropic',
  contextWindow: HAIKU_WINDOW,
  imageTier: EImageTier.Standard,
}

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

async function readingsOf({ script }: { script: readonly ScriptedStep[] }): Promise<{
  readings: { tokens: number; window: number }[]
  run: (text: string) => Promise<void>
}> {
  const temp = createTempDatabase()
  const harness = await buildHarness({
    databaseUrl: temp.databaseUrl,
    model: scriptedModel({ script }),
    identity: { id: 'anthropic', modelId: 'claude-haiku-4-5' },
    card: HAIKU_CARD,
  })
  opened.push({ harness, temp })

  const registry = new InMemoryToolRegistry([touchTool])
  const readings: { tokens: number; window: number }[] = []
  const runner = new LoopTurnRunner({
    log: harness.log,
    model: harness.model,
    ids: harness.ids,
    assembly: defaultPipeline({ prompt: () => EMPTY_PROMPT, launchDirectory: PROJECT_DIRECTORY }),
    tools: () => registry.declarations(),
    dispatch: new HookedToolDispatcher({ approvals: EApprovalRouting.Operator, registry, hooks: new HookChain({}) }),
    onContext: (reading) => readings.push(reading),
  })

  return {
    readings,
    run: async (text) => {
      const thread = await harness.threads.create({})
      await runner.say({ threadId: thread.id, text })
    },
  }
}

describe('a turn that was handed a context observer', () => {
  it('reports the assembled size against the window of the model it measured', async () => {
    const measured = await readingsOf({ script: [{ text: 'nothing to do' }] })

    await measured.run('what changed?')

    expect(measured.readings).toHaveLength(1)
    expect(measured.readings[0]?.window).toBe(HAIKU_WINDOW)
    expect(measured.readings[0]?.tokens).toBeGreaterThan(0)
  })

  it('reports once per model step, so the reading tracks a turn that keeps stepping', async () => {
    const measured = await readingsOf({
      script: [
        { text: 'touching', calls: [{ callId: 'call-1', name: 'touch', input: {} }] },
        { text: 'touched it' },
      ],
    })

    await measured.run('touch something')

    expect(measured.readings).toHaveLength(2)
    const [first, second] = measured.readings
    expect(second?.tokens).toBeGreaterThan(first?.tokens ?? 0)
  })
})
