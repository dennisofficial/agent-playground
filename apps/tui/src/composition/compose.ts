import { homedir } from 'node:os'

import {
  AccountStorePort,
  BeforeTurnHook,
  ClockPort,
  CredentialPort,
  defaultPipeline,
  EAgentStatus,
  EPromptAgent,
  DEFAULT_WORKTREE_DIRECTORY,
  ESettingId,
  choiceValueOf,
  EShellStatus,
  EventLogPort,
  IdPort,
  IMAGES_KEPT_IN_CONTEXT,
  ModelPort,
  promptContextFor,
  rangeValueOf,
  toThreadId,
  type ThreadId,
  type EventDraft,
  type WorkspaceIdentity,
} from '@dltech/atlas-core'
import {
  AccountsService,
  agentTypeSources,
  AgentRegistryPort,
  AiSdkModelPort,
  anthropicThinkingOptions,
  bindAgentTypes,
  pinnedModelSource,
  ChildRunnerDepsToken,
  subAgentPrompt,
  ThreadStorePort,
  AnthropicUsageClient,
  builtinOauthClients,
  createAccountUsageService,
  createAnthropicOauthModel,
  createDeltaChannel,
  createHarnessContainer,
  atlasDirectory,
  createSecurityKeychainReader,
  createUrlOpener,
  disposeAll,
  HookChainToken,
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
  SkillRegistryPort,
  summaryFor,
  titleFor,
  ToolDispatcher,
  ToolRegistry,
  TurnLedgerPort,
  TurnRunner,
  WorkspaceRoot,
  WorktreeDirectoryToken,
  FileBrowser,
  type UrlOpener,
  type AccountUsageService,
  type AgentTypeCatalog,
  type ChildRunnerDeps,
  type TurnDeps,
  type DeltaChannel,
  type DiscoveredSkill,
  type SettingsService,
} from '@dltech/atlas-harness'

import { createPendingQueue, type PendingQueue } from '../store'
import type { ActiveConversation } from './resume-hint'
import { compactTurn, ECompaction, type Summariser } from './compact-turn'
import { SUMMARISER_MODEL_ID, TITLER_MODEL_ID, type AtlasConfig } from './config'
import { launchSelection, rememberSelection } from './model-preference'
import { faultInjected } from './fault-injection'
import { modelIsReachable, selectableModel, type ModelChoice } from './model-selection'
import { instructionPlanOf } from './instruction-plan'
import type { SettingsBinding } from './settings-binding'
import { bindSkillRegistry, liveSkillRegistry } from './skills-binding'
import { userSaidDraft } from './user-said'

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
  agents: AgentRegistryPort
  model: ModelChoice
  settings: SettingsService
  usage: AccountUsageService
  files: FileBrowser
  openUrl: UrlOpener
  skills: readonly DiscoveredSkill[]
  skillRegistry: SkillRegistryPort
  agentTypes: AgentTypeCatalog
  close: () => Promise<void>
}

export async function composeAtlas(args: {
  config: AtlasConfig
  env: Record<string, string | undefined>
  settings: SettingsBinding
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
  const settings = args.settings.service
  args.settings.bindTo(container)

  container.register(WorktreeDirectoryToken, {
    useValue: () =>
      choiceValueOf({
        resolution: settings.snapshot().resolution,
        id: ESettingId.WorktreeDirectory,
        fallback: DEFAULT_WORKTREE_DIRECTORY,
      }),
  })

  container.register(portToken(BeforeTurnHook), {
    useValue: new LoadInstructionsHook({
      source: ({ projectDirectory }) => instructionPlanOf({ settings, projectDirectory }),
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

  const skillRegistry = bindSkillRegistry({
    container,
    registry: await liveSkillRegistry({
      atlasHome: atlasDirectory(),
      home: homedir(),
      cwd: config.cwd,
    }),
  })

  const agentTypes = await bindAgentTypes({
    container,
    sources: await agentTypeSources({
      atlasHome: atlasDirectory(),
      home: homedir(),
      cwd: config.cwd,
    }),
    modelIsUsable: modelIsReachable,
    subagentModelId: config.subagentModelId,
  })

  const log = container.resolve(portToken(EventLogPort))
  const ids = container.resolve(portToken(IdPort))
  const threads = container.resolve(portToken(ThreadStorePort))
  const ledger = container.resolve(portToken(TurnLedgerPort))
  const tools = container.resolve(portToken(ToolRegistry)).declarations()
  const modelPort = faultInjected(container.resolve(portToken(ModelPort)))
  const prompts = container.resolve(portToken(PromptRegistry))
  const compiledPrompt = ({ projectDirectory }: { projectDirectory: string }) =>
    prompts.compile(
      promptContextFor({
        agent: EPromptAgent.Main,
        provider: modelPort.identity,
        projectDirectory,
      }),
    )
  const shells = container.resolve(portToken(ShellRegistryPort))
  const agents = container.resolve(portToken(AgentRegistryPort))

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
   * close path appends what teardown produced before the database goes — each ending to the thread
   * that started the shell, which is not necessarily the one on screen when the session ended.
   */
  const recordTeardownEndings = async (): Promise<void> => {
    await Promise.all([shells.closeAll(), agents.closeAll()])

    for (const source of [shells, agents]) {
      for (const threadId of source.threadsAwaitingNotice()) {
        const drafts = source.drainNotifications({ threadId })
        if (drafts.length === 0) continue

        await log.append({ threadId, runId: ids.nextRunId(), drafts })
      }
    }
  }

  const runningShells = ({ threadId }: { threadId: ThreadId }) =>
    shells
      .list({ threadId })
      .filter((shell) => shell.status === EShellStatus.Running)
      .map((shell) => ({
        shellId: shell.shellId,
        command: shell.command,
        description: shell.description,
        awaitingInput: shell.awaitingInput,
        totalCharacters: shell.totalCharacters,
      }))

  const runningAgents = ({ threadId }: { threadId: ThreadId }) =>
    agents
      .list({ threadId })
      .filter((agent) => agent.status === EAgentStatus.Running)
      .map((agent) => ({
        agentId: agent.agentId,
        agentType: agent.agentType,
        intent: agent.intent,
      }))

  const drainNotices = async ({
    threadId,
  }: {
    threadId: ThreadId
  }): Promise<readonly EventDraft[]> => [
    ...shells.drainNotifications({ threadId }),
    ...agents.drainNotifications({ threadId }),
  ]

  const imagesKept = (): number =>
    rangeValueOf({
      resolution: settings.snapshot().resolution,
      id: ESettingId.ImagesKept,
      fallback: IMAGES_KEPT_IN_CONTEXT,
    })

  const turn: TurnDeps = {
    log,
    model: modelPort,
    ids,
    assembly: defaultPipeline({
      prompt: compiledPrompt,
      launchDirectory: config.cwd,
      runningShells,
      runningAgents,
      imagesKept,
    }),
    launchDirectory: config.cwd,
    tools,
    dispatch: container.resolve(portToken(ToolDispatcher)),
    hooks: container.resolve(HookChainToken),
    drainPending: async (args) => [
      ...pending.drain().map(userSaidDraft),
      ...(await drainNotices(args)),
    ],
    spend: { ledger, clock: container.resolve(portToken(ClockPort)) },
    compact: compactBeforeOverflow,
  }

  const modelFor = pinnedModelSource({
    subagentModelId: config.subagentModelId,
    inherited: () => modelPort,
    build: ({ modelId }) =>
      faultInjected(
        new AiSdkModelPort({
          model: createAnthropicOauthModel({
            credentials,
            modelId,
            providerOptions: anthropicThinkingOptions({
              modelId,
              effort: model.choice().effort,
            }),
          }),
          hooks: container.resolve(HookChainToken),
        }),
      ),
  })

  /**
   * The supervisor holds this as a thunk rather than a value: `agent_spawn` is a ToolDefinition the
   * ToolRegistry constructs, so resolving a child's tools while the supervisor is being built would
   * close the cycle. Nothing here is read until the first spawn.
   */
  container.register(ChildRunnerDepsToken, {
    useValue: (): ChildRunnerDeps => ({
      turn,
      tools: container.resolve(portToken(ToolRegistry)),
      hooks: container.resolve(HookChainToken),
      drainNotices,
      modelFor,
      assemblyFor: ({ agentType }) =>
        defaultPipeline({
          prompt: ({ projectDirectory }) =>
            subAgentPrompt({
              prompts,
              agentType,
              provider: modelPort.identity,
              projectDirectory,
            }),
          launchDirectory: config.cwd,
          runningShells,
          imagesKept,
        }),
    }),
  })

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
    skills: skillRegistry.all(),
    skillRegistry,
    agentTypes,
    files: new FileBrowser({ root: config.cwd }),
    openUrl: createUrlOpener(),
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
    agents,
    model,
    close: async () => {
      usage.dispose()
      await recordTeardownEndings().catch(() => undefined)
      await disposeAll({ container })
    },
    runner: new PublishingTurnRunner({ channel, deps: turn }),
  }
}
