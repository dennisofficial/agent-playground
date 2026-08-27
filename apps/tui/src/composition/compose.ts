import {
  ClockPort,
  CredentialPort,
  defaultPipeline,
  EventLogPort,
  IdPort,
  ModelPort,
} from '@dltech/atlas-core'
import {
  BranchStorePort,
  createDeltaChannel,
  createHarnessContainer,
  createPublishingTurnRunner,
  createSecurityKeychainReader,
  disposeAll,
  DispatchToken,
  KeychainCredentialPort,
  KeychainReaderToken,
  LanguageModelToken,
  openAtlasDatabase,
  portToken,
  PrismaClientToken,
  registerDisposable,
  ShellRegistryPort,
  ToolRegistry,
  TurnLedgerPort,
  WorkspaceRoot,
  type DeltaChannel,
  type SettingsService,
  type TurnRunner,
} from '@dltech/atlas-harness'

import { createPendingQueue, type PendingQueue } from '../store'
import type { AtlasConfig } from './config'
import { launchSelection, rememberSelection } from './model-preference'
import { selectableModel, type ModelChoice } from './model-selection'
import { bindSettings } from './settings-binding'

export type AtlasApp = {
  config: AtlasConfig
  credentials: CredentialPort
  channel: DeltaChannel
  runner: TurnRunner
  log: EventLogPort
  branches: BranchStorePort
  ids: IdPort
  pending: PendingQueue
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

  return {
    config,
    settings,
    credentials,
    channel,
    log,
    branches,
    ids,
    pending,
    model,
    close: () => disposeAll({ container }),
    runner: createPublishingTurnRunner({
      channel,
      deps: {
        log,
        model: container.resolve(portToken(ModelPort)),
        ids,
        assembly: defaultPipeline({ root: config.cwd, tools }),
        tools,
        dispatch: container.resolve(DispatchToken),
        drainPending: async () => [...pending.drain(), ...shells.drainNotifications()],
        spend: {
          ledger: container.resolve(portToken(TurnLedgerPort)),
          clock: container.resolve(portToken(ClockPort)),
        },
      },
    }),
  }
}
