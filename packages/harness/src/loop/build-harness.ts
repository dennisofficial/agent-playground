import type { LanguageModel } from 'ai'

import {
  defaultPipeline,
  EMPTY_PROMPT,
  type AssemblyPipeline,
  type Assembled,
  type ChunkFilter,
  type ClockPort,
  type CompiledPrompt,
  type EventLogPort,
  type IdPort,
  type ModelPort,
  type ProviderIdentity,
  type ThreadId,
  type ToolDeclaration,
} from '@dltech/atlas-core'

import type { HookChain } from '../hooks/registry'
import type { TurnLedgerPort } from '../ledger'
import { PrismaTurnLedger } from '../ledger'
import { AiSdkModelPort, type ModelCardSource } from '../model/ai-sdk-model-port'
import { createRawTape } from '../model/raw-tape'
import type { ToolDispatcher } from '../tools/dispatch'
import { openAtlasDatabase, PrismaThreadStore, PrismaEventLog, RandomIds, SystemClock } from '../store'
import type { ThreadStorePort } from '../store'
import { LoopTurnRunner, type TurnDeps } from './run-turn'
import { TurnRunner } from './turn-runner.port'

export type AtlasHarness = {
  runner: TurnRunner
  log: EventLogPort
  threads: ThreadStorePort
  model: ModelPort
  ids: IdPort
  clock: ClockPort
  ledger: TurnLedgerPort
  databaseUrl: string
  close: () => Promise<void>
}

export type BuildHarnessArgs = {
  model: LanguageModel
  databaseUrl?: string | undefined
  identity?: ProviderIdentity | undefined
  card?: ModelCardSource | undefined
  assembly?: AssemblyPipeline | undefined
  prompt?: CompiledPrompt | undefined
  tools?: (() => readonly ToolDeclaration[]) | undefined
  dispatch?: ToolDispatcher | undefined
  countTokens?: ((assembled: Assembled) => number) | undefined
  clock?: ClockPort | undefined
  ids?: IdPort | undefined
  onChunk?: ChunkFilter | undefined
  hooks?: HookChain | undefined
  compact?: ((args: { threadId: ThreadId }) => Promise<boolean>) | undefined
  autoCompactAtPercent?: (() => number) | undefined
  launchDirectory?: string | undefined
}

export async function buildHarness(args: BuildHarnessArgs): Promise<AtlasHarness> {
  const database = await openAtlasDatabase(
    args.databaseUrl === undefined ? {} : { databaseUrl: args.databaseUrl },
  )

  const clock = args.clock ?? new SystemClock()
  const ids = args.ids ?? new RandomIds()
  const log = new PrismaEventLog(database.prisma, clock, ids)
  const tape = createRawTape({ scope: `pid-${process.pid}` })
  const model = new AiSdkModelPort({
    model: args.model,
    ...(args.identity === undefined ? {} : { identity: args.identity }),
    ...(args.card === undefined ? {} : { card: args.card }),
    hooks: args.hooks,
    tape,
  })
  const ledger = new PrismaTurnLedger(database.prisma)

  const turnDeps: TurnDeps = {
    log,
    model,
    ids,
    assembly:
      args.assembly ??
      defaultPipeline({
        prompt: () => args.prompt ?? EMPTY_PROMPT,
        launchDirectory: args.launchDirectory ?? process.cwd(),
      }),
    tools: args.tools,
    dispatch: args.dispatch,
    countTokens: args.countTokens,
    onChunk: args.onChunk,
    hooks: args.hooks,
    spend: { ledger, clock },
    launchDirectory: args.launchDirectory,
    ...(args.compact === undefined ? {} : { compact: args.compact }),
    ...(args.autoCompactAtPercent === undefined
      ? {}
      : { autoCompactAtPercent: args.autoCompactAtPercent }),
  }

  return {
    runner: new LoopTurnRunner(turnDeps),
    log,
    threads: new PrismaThreadStore(database.prisma, clock, ids),
    model,
    ids,
    clock,
    ledger,
    databaseUrl: database.databaseUrl,
    close: async () => {
      await tape.close()
      await database.close()
    },
  }
}
