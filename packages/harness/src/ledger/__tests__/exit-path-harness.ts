import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

import {
  defaultPipeline,
  EBeforeToolDecision,
  EFinishReason,
  EStage,
  EToolEffect,
  toCallId,
  type ThreadId,
  type ModelPort,
  type ModelStepResult,
  type ModelToolCall,
  type ModelUsage,
  type ProviderIdentity,
  type ToolDefinition,
} from '@dltech/atlas-core'

import { HookChain } from '../../hooks/registry'
import { LoopTurnRunner, type TurnDeps } from '../../loop/run-turn'
import { TurnRunner } from '../../loop/turn-runner.port'
import { ModelStreamError } from '../../model/errors'
import { openAtlasDatabase, PrismaThreadStore, PrismaEventLog, RandomIds, SystemClock } from '../../store'
import { HookedToolDispatcher } from '../../tools/dispatch'
import { InMemoryToolRegistry } from '../../tools/registry'
import { PrismaTurnLedger } from '../prisma-turn-ledger'
import type { TurnLedgerPort, TurnSpend } from '../turn-ledger.port'

const MODEL: ProviderIdentity = { id: 'anthropic', modelId: 'claude-opus-5' }

export type ExitStep = {
  text?: string
  callName?: string
  usage?: ModelUsage
  fails?: string
  crashes?: string
  interruptsWith?: AbortController
}

export enum EDispatchMode {
  None = 'none',
  Auto = 'auto',
  Ask = 'ask',
}

export const fakeLedger = (args: { rejects?: boolean } = {}): TurnLedgerPort => {
  const rows: TurnSpend[] = []
  return {
    record: async (spend) => {
      if (args.rejects === true) throw new Error('the ledger is unavailable')
      rows.push(spend)
    },
    forThread: async ({ threadId }) => rows.filter((row) => row.threadId === threadId),
  }
}

const touchTool: ToolDefinition = {
  name: 'touch',
  description: 'do nothing at all',
  effect: EToolEffect.Read,
  inputSchema: z.object({}),
  invoke: async () => ({ ok: true, output: 'touched', modelText: 'touched' }),
}

const resultOf = (step: ExitStep, ordinal: number): ModelStepResult => {
  const toolCalls: ModelToolCall[] =
    step.callName === undefined
      ? []
      : [{ callId: toCallId(`call-${ordinal}`), name: step.callName, input: {} }]

  return {
    parts: step.text === undefined ? [] : [{ type: 'text', text: step.text }],
    toolCalls,
    finishReason: toolCalls.length > 0 ? EFinishReason.ToolCalls : EFinishReason.Stop,
    ...(step.usage === undefined ? {} : { usage: step.usage }),
  }
}

const scriptedPort = (script: readonly ExitStep[]): { port: ModelPort; taken: () => number } => {
  let ordinal = 0

  return {
    taken: () => ordinal,
    port: {
      identity: MODEL,
      step: async () => {
        const step = script[ordinal] ?? {}
        ordinal += 1

        if (step.crashes !== undefined) throw new Error(step.crashes)
        if (step.fails !== undefined) throw new ModelStreamError({ message: step.fails })
        step.interruptsWith?.abort()

        return resultOf(step, ordinal)
      },
    },
  }
}

const askEverything = new HookChain({
  beforeTool: [
    {
      name: 'askEverything',
      order: { stage: EStage.Policy, nudge: 50 },
      run: async () => ({ decision: EBeforeToolDecision.Ask, reason: 'a human should look at this' }),
    },
  ],
})

export type ExitPathHarness = {
  runner: TurnRunner
  threadId: ThreadId
  recorded: () => Promise<readonly TurnSpend[]>
  stepsTaken: () => number
  failures: () => readonly unknown[]
  close: () => Promise<void>
}

export async function openExitPathHarness(args: {
  script: readonly ExitStep[]
  dispatchMode?: EDispatchMode
  ledger?: TurnLedgerPort
  persist?: boolean
  createRunner?: (deps: TurnDeps) => TurnRunner
}): Promise<ExitPathHarness> {
  const buildRunner = args.createRunner ?? ((deps: TurnDeps) => new LoopTurnRunner(deps))
  const directory = mkdtempSync(join(tmpdir(), 'atlas-exit-'))
  const database = await openAtlasDatabase({ databaseUrl: `file:${join(directory, 'harness.db')}` })
  const clock = new SystemClock()
  const ids = new RandomIds()
  const thread = await new PrismaThreadStore(database.prisma, clock, ids).create({})

  const ledger = args.ledger ?? (args.persist === true ? new PrismaTurnLedger(database.prisma) : fakeLedger())
  const failures: unknown[] = []
  const model = scriptedPort(args.script)
  const registry = new InMemoryToolRegistry([touchTool])
  const mode = args.dispatchMode ?? EDispatchMode.None
  const hooks = mode === EDispatchMode.Ask ? askEverything : new HookChain({})

  return {
    threadId: thread.id,
    recorded: () => ledger.forThread({ threadId: thread.id }),
    stepsTaken: model.taken,
    failures: () => failures,
    runner: buildRunner({
      log: new PrismaEventLog(database.prisma, clock, ids),
      model: model.port,
      ids,
      assembly: defaultPipeline(),
      tools: registry.declarations(),
      hooks,
      ...(mode === EDispatchMode.None ? {} : { dispatch: new HookedToolDispatcher({ registry, hooks }) }),
      spend: { ledger, clock, onLedgerFailure: (error) => failures.push(error) },
    }),
    close: async () => {
      await database.close()
      rmSync(directory, { recursive: true, force: true })
    },
  }
}
