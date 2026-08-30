import { join } from 'node:path'

import {
  AccountStorePort,
  BeforeTurnHook,
  ClockPort,
  CredentialPort,
  defaultPipeline,
  EPromptAgent,
  EventLogPort,
  IdPort,
  ModelPort,
  promptContextFor,
  toThreadId,
  type ThreadId,
  type EventDraft,
  type WorkspaceIdentity,
} from '@dltech/atlas-core'
import {
  AccountsService,
  ThreadStorePort,
  AnthropicUsageClient,
  builtinOauthClients,
  createAccountUsageService,
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
  probeWorkspace,
  ClaudeCodeSource,
  ClaudeCodeSourceToken,
  KeychainReaderToken,
  claudeCodePayloadStore,
  importClaudeCodeAccount,
  syncEnvironmentAccounts,
  LanguageModelToken,
  openAtlasDatabase,
  portToken,
  PrismaClientToken,
  PromptRegistry,
  PublishingTurnRunner,
  registerBuiltinPromptFragments,
  registerDisposable,
  ShellRegistryPort,
  summaryFor,
  titleFor,
  ToolDispatcher,
  ToolRegistry,
  TurnLedgerPort,
  TurnRunner,
  WorkspaceRoot,
  FileBrowser,
  type AccountUsageService,
  type DeltaChannel,
  type DiscoveredSkill,
  type SettingsService,
} from '@dltech/atlas-harness'

import { createPendingQueue, type PendingQueue } from '../store'
import type { ActiveConversation } from './resume-hint'
import { compactTurn, ECompaction, type Summariser } from './compact-turn'
import { SUMMARISER_MODEL_ID, TITLER_MODEL_ID, type AtlasConfig } from './config'
import { launchSelection, rememberSelection } from './model-preference'
import { selectableModel, type ModelChoice } from './model-selection'
import { instructionPlanOf } from './instruction-plan'
import { bindSettings } from './settings-binding'

export type SessionTitler = (args: { text: string; signal?: AbortSignal }) => Promise<string | null>

export type AtlasApp = {
  config: AtlasConfig
  workspace: WorkspaceIdentity
  markActiveThread: (active: ActiveConversation) => void
  activeThread: () => ActiveConversation | null
  titler: SessionTitler
  summarise: Summariser
  credentials: CredentialPort
  accounts: AccountsService
  channel: DeltaChannel
  runner: TurnRunner
  log: EventLogPort
  threads: ThreadStorePort
  ledger: TurnLedgerPort
  ids: IdPort
  pending: PendingQueue
  shells: ShellRegistryPort
  model: ModelChoice
  settings: SettingsService
  usage: AccountUsageService
  files: FileBrowser
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
  const workspace = await probeWorkspace({ cwd: config.cwd })

  registerBuiltinPromptFragments({ container })
  container.register(WorkspaceRoot, { useValue: config.cwd })
  container.register(KeychainReaderToken, { useValue: createSecurityKeychainReader() })

  const keychainService = config.keychainService
  if (keychainService !== undefined) {
    container.register(ClaudeCodeSourceToken, {
      useFactory: (resolver) =>
        new ClaudeCodeSource(
          claudeCodePayloadStore({
            reader: resolver.resolve(KeychainReaderToken),
            service: keychainService,
          }),
        ),
    })
  }

  const credentials = container.resolve(portToken(CredentialPort))
  const accountStore = container.resolve(portToken(AccountStorePort))

  await syncEnvironmentAccounts({ accounts: accountStore, env: args.env })
  await importClaudeCodeAccount({
    accounts: accountStore,
    source: container.resolve(ClaudeCodeSourceToken),
  })

  const accounts = new AccountsService({
    accounts: accountStore,
    clients: builtinOauthClients({ clock: container.resolve(portToken(ClockPort)) }),
  })
  const usage = createAccountUsageService({ usage: new AnthropicUsageClient({ credentials }) })
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
  const ledger = container.resolve(portToken(TurnLedgerPort))
  const tools = container.resolve(portToken(ToolRegistry)).declarations()
  const modelPort = container.resolve(portToken(ModelPort))
  const prompts = container.resolve(portToken(PromptRegistry))
  const compiledPrompt = () =>
    prompts.compile(promptContextFor({ agent: EPromptAgent.Main, provider: modelPort.identity }))
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

  let activeThread: ActiveConversation | null = null

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
  const compactBeforeOverflow = async ({ threadId }: { threadId: ThreadId }): Promise<boolean> => {
    const compaction = await compactTurn({
      log,
      threads,
      threadId,
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

    const active = activeThread
    const drafts = shells.drainNotifications()
    if (active === null || drafts.length === 0) return

    await log.append({ threadId: toThreadId(active.threadId), runId: ids.nextRunId(), drafts })
  }

  return {
    config,
    workspace,
    markActiveThread: (active) => {
      activeThread = active
    },
    activeThread: () => activeThread,
    titler: ({ text, signal }) => titleFor({ model: titlerModel, text, signal }),
    summarise,
    settings,
    skills,
    files: new FileBrowser({ root: config.cwd }),
    credentials,
    accounts,
    usage,
    channel,
    log,
    threads,
    ledger,
    ids,
    pending,
    shells,
    model,
    close: async () => {
      usage.dispose()
      await recordTeardownEndings().catch(() => undefined)
      await disposeAll({ container })
    },
    runner: new PublishingTurnRunner({
      channel,
      deps: {
        log,
        model: modelPort,
        ids,
        assembly: defaultPipeline({ prompt: compiledPrompt, projectDirectory: config.cwd }),
        projectDirectory: config.cwd,
        tools,
        dispatch: container.resolve(portToken(ToolDispatcher)),
        hooks: container.resolve(HookChainToken),
        drainPending: async () => [
          ...pending.drain().map((text): EventDraft => ({ type: 'user-said', text })),
          ...shells.drainNotifications(),
        ],
        spend: { ledger, clock: container.resolve(portToken(ClockPort)) },
        compact: compactBeforeOverflow,
      },
    }),
  }
}
