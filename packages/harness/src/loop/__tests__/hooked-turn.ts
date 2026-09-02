import { afterEach } from 'bun:test'
import type { MockLanguageModelV4 } from 'ai/test'

import { z } from 'zod'

import { defaultPipeline, EToolEffect, type ToolDefinition } from '@dltech/atlas-core'

import { buildHarness, LoopTurnRunner, TurnRunner, type AtlasHarness } from '..'
import type { HookChain } from '../../hooks/registry'
import { scriptedModel, type ScriptedStep } from '../../model/testing/scripted-model'
import { EApprovalRouting, HookedToolDispatcher } from '../../tools/dispatch'
import { InMemoryToolRegistry } from '../../tools/registry'
import { fixturePrompt } from './fixture-prompt'
import { createTempDatabase, type TempDatabase } from './temp-database'

const PROJECT_DIRECTORY = '/w'

const opened: { harness: AtlasHarness; temp: TempDatabase }[] = []

afterEach(async () => {
  for (const entry of opened.splice(0)) {
    await entry.harness.close()
    entry.temp.discard()
  }
})

export const keepOpen = (entry: { harness: AtlasHarness; temp: TempDatabase }): void => {
  opened.push(entry)
}

export const touchTool: ToolDefinition = {
  name: 'touch',
  description: 'do nothing at all',
  effect: EToolEffect.Read,
  inputSchema: z.object({}),
  invoke: async () => ({ ok: true, output: 'touched', modelText: 'touched' }),
}

export async function openHooked(args: {
  script: readonly ScriptedStep[]
  hooks: HookChain
  withTools?: boolean
}): Promise<{
  runner: TurnRunner
  harness: AtlasHarness
  model: MockLanguageModelV4
}> {
  const temp = createTempDatabase()
  const model = scriptedModel({ script: args.script })
  const harness = await buildHarness({ databaseUrl: temp.databaseUrl, model, hooks: args.hooks })
  keepOpen({ harness, temp })

  const tools = new InMemoryToolRegistry([touchTool])

  return {
    harness,
    model,
    runner: new LoopTurnRunner({
      log: harness.log,
      model: harness.model,
      ids: harness.ids,
      assembly: defaultPipeline({ prompt: () => fixturePrompt(), launchDirectory: PROJECT_DIRECTORY }),
      hooks: args.hooks,
      ...(args.withTools === true
        ? {
            tools: () => tools.declarations(),
            dispatch: new HookedToolDispatcher({ approvals: EApprovalRouting.Operator, registry: tools, hooks: args.hooks }),
          }
        : {}),
    }),
  }
}
