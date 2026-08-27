import {
  ClockPort,
  CredentialPort,
  defaultPipeline,
  EventLogPort,
  IdPort,
  ModelPort,
  type BranchId,
  type EventDraft,
} from '@dltech/atlas-core'
import {
  BranchStorePort,
  createAnthropicOauthModel,
  createDeltaChannel,
  createHarnessContainer,
  createSecurityKeychainReader,
  disposeAll,
  KeychainCredentialPort,
  KeychainReaderToken,
  LanguageModelToken,
  openAtlasDatabase,
  portToken,
  PrismaClientToken,
  PublishingTurnRunner,
  registerDisposable,
  ShellRegistryPort,
  summaryFor,
  titleFor,
  ToolDispatcher,
  ToolRegistry,
  TurnLedgerPort,
  TurnRunner,
  WorkspaceRoot,
  type DeltaChannel,
  type SettingsService,
} from '@dltech/atlas-harness'

import { createPendingQueue, type PendingQueue } from '../store'
import type { Summariser } from './compact-turn'
import { SUMMARISER_MODEL_ID, TITLER_MODEL_ID, type AtlasConfig } from './config'
import { launchSelection, rememberSelection } from './model-preference'
import { selectableModel, type ModelChoice } from './model-selection'
import { bindSettings } from './settings-binding'

export type SessionTitler = (args: { text: string; signal?: AbortSignal }) => Promise<string | null>

export type AtlasApp = {
  config: AtlasConfig
  markActiveBranch: (branchId: BranchId) => void
  titler: SessionTitler
  summarise: Summariser
  credentials: CredentialPort
  channel: DeltaChannel
  runner: TurnRunner
  log: EventLogPort
  branches: BranchStorePort
  ids: IdPort
  pending: PendingQueue
  shells: ShellRegistryPort
  model: ModelChoice
  settings: SettingsService
  close: () => Promise<void>
}

export async function composeAtlas(args: {
  config: AtlasConfig
  env: Record<string, string | undefined>
}): Promise<AtlasApp> {
  const { config } = args
  const container = createHarnessContainer()

  container.register(WorkspaceRoot, { useValue: config.cwd })
  container.register(KeychainReaderToken, { useValue: createSecurityKeychainReader() })

  const service = config.keychainService
  if (service !== undefined) {
    container.register(portToken(CredentialPort), {
      useFactory: (resolver) =>
        new KeychainCredentialPort({
          reader: resolver.resolve(KeychainReaderToken),
          clock: resolver.resolve(portToken(ClockPort)),
          service,
        }),
    })
  }

  const credentials = container.resolve(portToken(CredentialPort))
  const settings = bindSettings({ container, env: args.env, cwd: config.cwd })

  const model = selectableModel({
    credentials,
    initial: launchSelection({
      requested: { modelId: config.modelId, thinkingBudgetTokens: config.thinkingBudgetTokens },
      remembered: settings.snapshot().document,
    }),
    remember: (selection) => rememberSelection({ settings, selection }),
  })

  container.register(LanguageModelToken, { useValue: model.model })

  const database = await openAtlasDatabase({ databaseUrl: config.databaseUrl })
  container.register(PrismaClientToken, { useValue: database.prisma })
  registerDisposable({ container, close: database.close })

  const log = container.resolve(portToken(EventLogPort))
  const ids = container.resolve(portToken(IdPort))
  const branches = container.resolve(portToken(BranchStorePort))
  const tools = container.resolve(portToken(ToolRegistry)).declarations()
  const shells = container.resolve(portToken(ShellRegistryPort))

  const channel = createDeltaChannel()
  const pending = createPendingQueue()

  let activeBranch: BranchId | null = null

  const titlerModel = createAnthropicOauthModel({ credentials, modelId: TITLER_MODEL_ID })
  const summariserModel = createAnthropicOauthModel({ credentials, modelId: SUMMARISER_MODEL_ID })

  /**
   * Teardown kills every background shell, and those endings are worth keeping: reopening the
   * conversation should say where the dev server went. Nothing is left running to drain them, so the
   * close path appends what teardown produced before the database goes.
   */
  const recordTeardownEndings = async (): Promise<void> => {
    await shells.closeAll()

    const branchId = activeBranch
    const drafts = shells.drainNotifications()
    if (branchId === null || drafts.length === 0) return

    await log.append({ branchId, runId: ids.nextRunId(), drafts })
  }

  return {
    config,
    markActiveBranch: (branchId) => {
      activeBranch = branchId
    },
    titler: ({ text, signal }) => titleFor({ model: titlerModel, text, signal }),
    summarise: ({ events, throughSeq }) => summaryFor({ model: summariserModel, events, throughSeq }),
    settings,
    credentials,
    channel,
    log,
    branches,
    ids,
    pending,
    shells,
    model,
    close: async () => {
      await recordTeardownEndings().catch(() => undefined)
      await disposeAll({ container })
    },
    runner: new PublishingTurnRunner({
      channel,
      deps: {
        log,
        model: container.resolve(portToken(ModelPort)),
        ids,
        assembly: defaultPipeline({ root: config.cwd, tools }),
        tools,
        dispatch: container.resolve(portToken(ToolDispatcher)),
        drainPending: async () => [
          ...pending.drain().map((text): EventDraft => ({ type: 'user-said', text })),
          ...shells.drainNotifications(),
        ],
        spend: {
          ledger: container.resolve(portToken(TurnLedgerPort)),
          clock: container.resolve(portToken(ClockPort)),
        },
      },
    }),
  }
}
