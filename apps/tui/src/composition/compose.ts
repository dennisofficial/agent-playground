import { join } from 'node:path'

import {
  BeforeTurnHook,
  ClockPort,
  CredentialPort,
  defaultPipeline,
  EventLogPort,
  IdPort,
  ModelPort,
  type ThreadId,
  type EventDraft,
} from '@dltech/atlas-core'
import {
  ThreadStorePort,
  createAnthropicOauthModel,
  createDeltaChannel,
  createHarnessContainer,
  ATLAS_DIRECTORY_NAME,
  atlasDirectory,
  createSecurityKeychainReader,
  disposeAll,
  EmbeddedSkillSource,
  ESkillOrigin,
  FilesystemSkillSource,
  HookChainToken,
  loadSkills,
  LoadInstructionsHook,
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
  type DiscoveredSkill,
  type SettingsService,
} from '@dltech/atlas-harness'

import { createPendingQueue, type PendingQueue } from '../store'
import { compactTurn, ECompaction, type Summariser } from './compact-turn'
import { SUMMARISER_MODEL_ID, TITLER_MODEL_ID, type AtlasConfig } from './config'
import { launchSelection, rememberSelection } from './model-preference'
import { selectableModel, type ModelChoice } from './model-selection'
import { instructionPlanOf } from './instruction-plan'
import { bindSettings } from './settings-binding'

export type SessionTitler = (args: { text: string; signal?: AbortSignal }) => Promise<string | null>

export type AtlasApp = {
  config: AtlasConfig
  markActiveThread: (threadId: ThreadId) => void
  titler: SessionTitler
  summarise: Summariser
  credentials: CredentialPort
  channel: DeltaChannel
  runner: TurnRunner
  log: EventLogPort
  threads: ThreadStorePort
  ids: IdPort
  pending: PendingQueue
  shells: ShellRegistryPort
  model: ModelChoice
  settings: SettingsService
  skills: readonly DiscoveredSkill[]
  close: () => Promise<void>
}

const SKILLS_DIRECTORY_NAME = 'skills'

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

  container.register(portToken(BeforeTurnHook), {
    useValue: new LoadInstructionsHook({
      source: () => instructionPlanOf({ settings, cwd: config.cwd }),
    }),
  })

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
  const threads = container.resolve(portToken(ThreadStorePort))
  const tools = container.resolve(portToken(ToolRegistry)).declarations()
  const shells = container.resolve(portToken(ShellRegistryPort))

  const skills = await loadSkills({
    sources: [
      new EmbeddedSkillSource(),
      new FilesystemSkillSource({
        directory: join(atlasDirectory(), SKILLS_DIRECTORY_NAME),
        origin: ESkillOrigin.User,
      }),
      new FilesystemSkillSource({
        directory: join(config.cwd, ATLAS_DIRECTORY_NAME, SKILLS_DIRECTORY_NAME),
        origin: ESkillOrigin.Project,
      }),
    ],
  })

  const channel = createDeltaChannel()
  const pending = createPendingQueue()

  let activeThread: ThreadId | null = null

  const titlerModel = createAnthropicOauthModel({ credentials, modelId: TITLER_MODEL_ID })
  const summariserModel = createAnthropicOauthModel({ credentials, modelId: SUMMARISER_MODEL_ID })

  const summarise: Summariser = ({ events, fromSeq, throughSeq, signal }) =>
    summaryFor({
      model: summariserModel,
      events,
      fromSeq,
      throughSeq,
      ...(signal === undefined ? {} : { signal }),
    })

  /**
   * The loop asks for this only when a step would otherwise be sent a prompt the window cannot hold,
   * which is the one moment compacting mid-turn is safe: the loop is between steps and re-reads the
   * log itself afterwards.
   */
  const compactBeforeOverflow = async (): Promise<boolean> => {
    const thread = await threads.mostRecent()
    if (thread === undefined) return false

    const compaction = await compactTurn({
      log,
      threads,
      threadId: thread.id,
      summarise,
    })
    return compaction.type === ECompaction.Compacted
  }

  /**
   * Teardown kills every background shell, and those endings are worth keeping: reopening the
   * conversation should say where the dev server went. Nothing is left running to drain them, so the
   * close path appends what teardown produced before the database goes.
   */
  const recordTeardownEndings = async (): Promise<void> => {
    await shells.closeAll()

    const threadId = activeThread
    const drafts = shells.drainNotifications()
    if (threadId === null || drafts.length === 0) return

    await log.append({ threadId, runId: ids.nextRunId(), drafts })
  }

  return {
    config,
    markActiveThread: (threadId) => {
      activeThread = threadId
    },
    titler: ({ text, signal }) => titleFor({ model: titlerModel, text, signal }),
    summarise,
    settings,
    skills,
    credentials,
    channel,
    log,
    threads,
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
        hooks: container.resolve(HookChainToken),
        drainPending: async () => [
          ...pending.drain().map((text): EventDraft => ({ type: 'user-said', text })),
          ...shells.drainNotifications(),
        ],
        spend: {
          ledger: container.resolve(portToken(TurnLedgerPort)),
          clock: container.resolve(portToken(ClockPort)),
        },
        compact: compactBeforeOverflow,
      },
    }),
  }
}
