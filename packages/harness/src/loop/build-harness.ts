import type { LanguageModel } from 'ai'

import {
  defaultPipeline,
  type AssemblyPipeline,
  type Assembled,
  type ChunkFilter,
  type ClockPort,
  type EventLogPort,
  type IdPort,
  type ModelPort,
  type ProviderIdentity,
  type ToolDeclaration,
} from '@dltech/atlas-core'

import type { HookRegistry } from '../hooks/registry'
import type { TurnLedgerPort } from '../ledger'
import { PrismaTurnLedger } from '../ledger'
import { createAiSdkModelPort } from '../model/ai-sdk-model-port'
import { createRawTape } from '../model/raw-tape'
import type { Dispatch } from '../tools/dispatch'
import { openAtlasDatabase, PrismaBranchStore, PrismaEventLog, RandomIds, SystemClock } from '../store'
import type { BranchStorePort } from '../store'
import { createTurnRunner, type TurnDeps, type TurnRunner } from './run-turn'

export type AtlasHarness = {
  runner: TurnRunner
  log: EventLogPort
  branches: BranchStorePort
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
  assembly?: AssemblyPipeline | undefined
  tools?: readonly ToolDeclaration[] | undefined
  dispatch?: Dispatch | undefined
  countTokens?: ((assembled: Assembled) => number) | undefined
  clock?: ClockPort | undefined
  ids?: IdPort | undefined
  onChunk?: ChunkFilter | undefined
  hooks?: HookRegistry | undefined
}

export function providerIdentityOf(model: LanguageModel): ProviderIdentity {
  if (typeof model === 'string') return { id: 'gateway', modelId: model }
  return { id: model.provider, modelId: model.modelId }
}

export async function buildHarness(args: BuildHarnessArgs): Promise<AtlasHarness> {
  const database = await openAtlasDatabase(
    args.databaseUrl === undefined ? {} : { databaseUrl: args.databaseUrl },
  )

  const clock = args.clock ?? new SystemClock()
  const ids = args.ids ?? new RandomIds()
  const log = new PrismaEventLog(database.prisma, clock, ids)
  const tape = createRawTape({ scope: `pid-${process.pid}` })
  const model = createAiSdkModelPort({
    model: args.model,
    identity: args.identity ?? providerIdentityOf(args.model),
    hooks: args.hooks,
    tape,
  })
  const ledger = new PrismaTurnLedger(database.prisma)

  const turnDeps: TurnDeps = {
    log,
    model,
    ids,
    assembly: args.assembly ?? defaultPipeline(),
    tools: args.tools,
    dispatch: args.dispatch,
    countTokens: args.countTokens,
    onChunk: args.onChunk,
    hooks: args.hooks,
    spend: { ledger, clock },
  }

  return {
    runner: createTurnRunner(turnDeps),
    log,
    branches: new PrismaBranchStore(database.prisma, clock, ids),
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
