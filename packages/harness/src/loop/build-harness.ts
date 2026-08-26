import type { LanguageModel } from 'ai'

import {
  defaultRules,
  type Annotator,
  type Assembled,
  type ChunkFilter,
  type ClockPort,
  type EventLogPort,
  type IdPort,
  type ModelPort,
  type ProviderIdentity,
  type Rule,
  type ToolDeclaration,
} from '@dltech/atlas-core'

import type { HookRegistry } from '../hooks/registry'
import { createAiSdkModelPort } from '../model/ai-sdk-model-port'
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
  databaseUrl: string
  close: () => Promise<void>
}

export type BuildHarnessArgs = {
  model: LanguageModel
  databaseUrl?: string | undefined
  identity?: ProviderIdentity | undefined
  rules?: readonly Rule[] | undefined
  annotators?: readonly Annotator[] | undefined
  tools?: readonly ToolDeclaration[] | undefined
  dispatch?: Dispatch | undefined
  maxSteps?: number | undefined
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
  const storeDeps = { prisma: database.prisma, clock, ids }

  const log = new PrismaEventLog(storeDeps)
  const model = createAiSdkModelPort({
    model: args.model,
    identity: args.identity ?? providerIdentityOf(args.model),
    hooks: args.hooks,
  })

  const turnDeps: TurnDeps = {
    log,
    model,
    ids,
    rules: args.rules ?? defaultRules(),
    annotators: args.annotators,
    tools: args.tools,
    dispatch: args.dispatch,
    maxSteps: args.maxSteps,
    countTokens: args.countTokens,
    onChunk: args.onChunk,
    hooks: args.hooks,
  }

  return {
    runner: createTurnRunner(turnDeps),
    log,
    branches: new PrismaBranchStore(storeDeps),
    model,
    ids,
    clock,
    databaseUrl: database.databaseUrl,
    close: database.close,
  }
}
