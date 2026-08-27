import { afterEach } from 'bun:test'
import type { MockLanguageModelV4 } from 'ai/test'
import { z } from 'zod'

import {
  defaultPipeline,
  EToolEffect,
  type BranchId,
  type EventLogPort,
  type IdPort,
  type ModelPort,
  type ToolDefinition,
} from '@dltech/atlas-core'

import { buildHarness, createTurnRunner, ETurnStatus, type AtlasHarness, type TurnRunner } from '..'
import { createHookRegistry, type HookRegistry } from '../../hooks/registry'
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

export type ComposerQueue = {
  type: (text: string) => void
  drain: () => Promise<readonly string[]>
  drains: () => number
}

function createComposerQueue(): ComposerQueue {
  let waiting: string[] = []
  let drains = 0

  return {
    type: (text) => {
      waiting.push(text)
    },
    drain: async () => {
      drains += 1
      const taken = waiting
      waiting = []
      return taken
    },
    drains: () => drains,
  }
}

function actingDuringStep(args: { model: ModelPort; onStep: number | 'each'; act: () => Promise<void> | void }): ModelPort {
  let taken = 0

  return {
    identity: args.model.identity,
    step: async (stepArgs) => {
      const result = await args.model.step(stepArgs)
      taken += 1
      if (args.onStep === 'each' || taken === args.onStep) await args.act()
      return result
    },
  }
}

const touchTool: ToolDefinition = {
  name: 'touch',
  description: 'do nothing at all',
  effect: EToolEffect.Read,
  inputSchema: z.object({}),
  invoke: async () => ({ ok: true, output: 'touched', modelText: 'touched' }),
}

export type Opened = {
  runner: TurnRunner
  harness: AtlasHarness
  model: MockLanguageModelV4
  branchId: BranchId
  queue: ComposerQueue
}

export async function openSteerable(args: {
  script: readonly ScriptedStep[]
  types?: { text: string; onStep: number | 'each' } | undefined
  appends?: { text: string; onStep: number } | undefined
  hooks?: HookRegistry | undefined
  withTools?: boolean | undefined
  withQueue?: boolean | undefined
}): Promise<Opened> {
  const temp = createTempDatabase()
  const model = scriptedModel({ script: args.script })
  const harness = await buildHarness({
    databaseUrl: temp.databaseUrl,
    model,
    ...(args.hooks === undefined ? {} : { hooks: args.hooks }),
  })
  opened.push({ harness, temp })

  const branch = await harness.branches.create({})
  const queue = createComposerQueue()
  const tools = createToolRegistry([touchTool])

  const steered = ((): ModelPort => {
    if (args.types !== undefined) {
      const typed = args.types
      return actingDuringStep({ model: harness.model, onStep: typed.onStep, act: () => queue.type(typed.text) })
    }
    if (args.appends !== undefined) {
      const appended = args.appends
      return actingDuringStep({
        model: harness.model,
        onStep: appended.onStep,
        act: () => appendStraightToLog({ log: harness.log, ids: harness.ids, branchId: branch.id, text: appended.text }),
      })
    }
    return harness.model
  })()

  return {
    harness,
    model,
    queue,
    branchId: branch.id,
    runner: createTurnRunner({
      log: harness.log,
      model: steered,
      ids: harness.ids,
      assembly: defaultPipeline(),
      ...(args.withQueue === false ? {} : { drainPending: queue.drain }),
      ...(args.hooks === undefined ? {} : { hooks: args.hooks }),
      ...(args.withTools === true
        ? { tools: tools.declarations(), dispatch: createDispatch({ registry: tools, hooks: createHookRegistry({}) }) }
        : {}),
    }),
  }
}

async function appendStraightToLog(args: {
  log: EventLogPort
  ids: IdPort
  branchId: BranchId
  text: string
}): Promise<void> {
  await args.log.append({
    branchId: args.branchId,
    runId: args.ids.nextRunId(),
    drafts: [{ type: 'user-said', text: args.text }],
  })
}

export const userTexts = (prompt: MockLanguageModelV4['doStreamCalls'][number]['prompt']): string[] =>
  prompt.flatMap((message) =>
    message.role === 'user'
      ? message.content.flatMap((part) => (part.type === 'text' ? [part.text] : []))
      : [],
  )

