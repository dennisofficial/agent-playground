import { homedir } from 'node:os'

import {
  ANTHROPIC_PROVIDER_ID,
  AccountStorePort,
  AfterShellHook,
  AfterToolHook,
  BeforeToolHook,
  BeforeTurnHook,
  ClockPort,
  CredentialPort,
  defaultPipeline,
  DEFAULT_CLASSIFIER_POLICY,
  EAgentStatus,
  EClassifierMode,
  environmentFor,
  EPromptAgent,
  DEFAULT_WORKTREE_DIRECTORY,
  EServiceStatus,
  ESettingId,
  EWebSearchBackend,
  backendOf,
  choiceValueOf,
  classifierModeOf,
  EShellStatus,
  EventLogPort,
  IdPort,
  JudgePort,
  ModelPort,
  parseRef,
  PromptFragment,
  promptContextFor,
  promptModelOf,
  rangeValueOf,
  textValueOf,
  toggleValueOf,
  toThreadId,
  type ThreadId,
  type EventDraft,
  type SecretsPort,
  type WorkspaceIdentity,
} from '@dltech/atlas-core'
import {
  AccountsService,
  agentTypeSources,
  AgentRegistryPort,
  AiSdkModelPort,
  AnthropicAdapter,
  cardsForProvider,
  InferenceAdapter,
  INFERENCE_PROVIDER_ID,
  OpenAiAdapter,
  OPENAI_PROVIDER_ID,
  OpenRouterAdapter,
  OPENROUTER_PROVIDER_ID,
  ProviderAdapter,
  bindAgentTypes,
  claimWorktree,
  EWorktreeClaim,
  releaseWorktree,
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
  atlasDatabaseUrl,
  atlasDirectory,
  createSecurityKeychainReader,
  createUrlOpener,
  disposeAll,
  HaikuJudge,
  HookChainToken,
  HookMishapReporterToken,
  type HookMishap,
  LoadInstructionsHook,
  LoadMemoryHook,
  memoryDirectoriesFor,
  MemoryFragment,
  StampMemoryHook,
  probeWorkspace,
  remotesOf,
  ClaudeCodeSource,
  ClaudeCodeSourceToken,
  KeychainReaderToken,
  claudeCodePayloadStore,
  importClaudeCodeAccount,
  syncEnvironmentAccounts,
  LanguageModelToken,
  ModelCardSourceToken,
  openAtlasDatabase,
  portToken,
  PrismaClientToken,
  PromptRegistry,
  PublishingTurnRunner,
  TldrTurnRunner,
  withDeltaPublishing,
  registerBuiltinPromptFragments,
  registerDisposable,
  registerMcp,
  ServiceRegistryPort,
  ShellRegistryPort,
  SkillRegistryPort,
  summaryFor,
  titleFor,
  ToolDispatcher,
  ToolRegistry,
  TurnLedgerPort,
  TurnRunner,
  WorkspaceRoot,
  ClassifierPolicyToken,
  WorktreeDirectoryToken,
  SecretsStoreToken,
  WebSearchBackendToken,
  FileBrowser,
  type UrlOpener,
  type AccountUsageService,
  type AgentTypeCatalog,
  type ChildRunnerDeps,
  type DependencyContainer,
  type TurnDeps,
  type DeltaChannel,
  type DiscoveredSkill,
  type McpServerStatus,
  type SettingsService,
} from '@dltech/atlas-harness'

import { createPendingQueue, type PendingQueue } from '../store'
import type { ActiveConversation } from './resume-hint'
import { compactTurn, ECompaction, type Summariser } from './compact-turn'
import { SUMMARISER_MODEL_ID, TITLER_MODEL_ID, TLDR_MODEL_ID, type AtlasConfig } from './config'
import { launchSelection, modelPinned } from './model-preference'
import { faultInjected } from './fault-injection'
import { mcpBootNotice } from './mcp-report'
import { selectableModel, type ModelChoice } from './model-selection'
import { knownRefs, modelCatalogue, type ModelCatalogue } from './providers'
import { assemblePlugins } from '../plugins/assemble'
import { ENoticeTone, NOTICE_WARN_MS, notify } from '../ui/notice-store'
import { tldrFeed } from '../ui/tldr-feed-store'
import type { ContributedProjection } from '../plugins/projection'
import type { ContributedSurface } from '../plugins/surface'
import { instructionPlanOf } from './instruction-plan'
import type { SettingsBinding } from './settings-binding'
import { bindSkillRegistry, liveSkillRegistry } from './skills-binding'
import { userSaidDraft } from './user-said'

export type SessionTitler = (args: { text: string; signal?: AbortSignal }) => Promise<string | null>

const SESSION_CLAIM_LABEL = 'session'

async function claimLaunchWorktree(args: {
  container: DependencyContainer
  workspace: WorkspaceIdentity
}): Promise<void> {
  const path = args.workspace.workspace
  const repo = args.workspace.repo
  if (repo === null || repo === path) return

  const claimed = await claimWorktree({ cwd: repo, path, label: SESSION_CLAIM_LABEL }).catch(
    () => undefined,
  )
  if (claimed?.claim !== EWorktreeClaim.Owned && claimed?.claim !== EWorktreeClaim.Reclaimed) return

  registerDisposable({
    container: args.container,
    close: async () => {
      await releaseWorktree({ cwd: repo, path })
    },
  })
}

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
  services: ServiceRegistryPort
  model: ModelChoice
  modelPinned: boolean
  models: ModelCatalogue
  settings: SettingsService
  secrets: SecretsPort
  usage: AccountUsageService
  files: FileBrowser
  openUrl: UrlOpener
  skills: readonly DiscoveredSkill[]
  skillRegistry: SkillRegistryPort
  agentTypes: AgentTypeCatalog
  pluginProjections: readonly ContributedProjection[]
  pluginSurfaces: readonly ContributedSurface[]
  mcp: () => readonly McpServerStatus[]
  threadOpened: (args: { threadId: ThreadId; projectDirectory: string }) => Promise<void>
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
  await claimLaunchWorktree({ container, workspace })
  const mcp = await registerMcp({ container, cwd: config.cwd })

  for (const server of mcp.servers()) {
    const notice = mcpBootNotice(server)
    if (notice !== null) {
      notify({
        key: `mcp:${server.spec.name}`,
        tone: ENoticeTone.Warn,
        ttlMs: NOTICE_WARN_MS,
        text: notice,
      })
    }
  }

  const settings = args.settings.service
  const settled = settings.snapshot().resolution
  const launchValue = (id: ESettingId): string | undefined => {
    const held = textValueOf({ resolution: settled, id })
    return held.length === 0 ? undefined : held
  }

  registerBuiltinPromptFragments({ container })
  container.register(WorkspaceRoot, { useValue: config.cwd })
  container.register(KeychainReaderToken, { useValue: createSecurityKeychainReader() })

  const keychainService = launchValue(ESettingId.KeychainService)
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
  args.settings.bindTo(container)

  container.register(WorktreeDirectoryToken, {
    useValue: () =>
      choiceValueOf({
        resolution: settings.snapshot().resolution,
        id: ESettingId.WorktreeDirectory,
        fallback: DEFAULT_WORKTREE_DIRECTORY,
      }),
  })

  const environment = environmentFor({
    projectDirectory: config.cwd,
    repoRoot: workspace.repo ?? undefined,
    worktreeHome:
      workspace.repo === null
        ? undefined
        : `${workspace.repo}/${choiceValueOf({
            resolution: settled,
            id: ESettingId.WorktreeDirectory,
            fallback: DEFAULT_WORKTREE_DIRECTORY,
          })}`,
    remotes: await remotesOf({ cwd: config.cwd }),
  })

  container.register(ClassifierPolicyToken, {
    useValue: () => ({
      ...DEFAULT_CLASSIFIER_POLICY,
      environment,
      mode:
        classifierModeOf(
          choiceValueOf({
            resolution: settings.snapshot().resolution,
            id: ESettingId.ClassifierMode,
            fallback: EClassifierMode.Shadow,
          }),
        ) ?? EClassifierMode.Shadow,
    }),
  })

  container.register(portToken(JudgePort), {
    useValue: new HaikuJudge({
      model: createAnthropicOauthModel({ credentials, modelId: TITLER_MODEL_ID }),
    }),
  })

  container.register(WebSearchBackendToken, {
    useValue: () =>
      backendOf(
        choiceValueOf({
          resolution: settings.snapshot().resolution,
          id: ESettingId.WebSearchBackend,
          fallback: EWebSearchBackend.DuckDuckGo,
        }),
      ) ?? EWebSearchBackend.DuckDuckGo,
  })

  container.register(portToken(BeforeTurnHook), {
    useValue: new LoadInstructionsHook({
      source: ({ projectDirectory }) => instructionPlanOf({ settings, projectDirectory }),
    }),
  })

  const memoryDirectories = memoryDirectoriesFor({
    atlasHome: atlasDirectory(),
    repoRoot: workspace.repo ?? workspace.workspace,
  })

  container.register(portToken(PromptFragment), {
    useValue: new MemoryFragment({ directories: memoryDirectories }),
  })

  container.register(portToken(BeforeTurnHook), {
    useValue: new LoadMemoryHook({ directories: memoryDirectories }),
  })

  container.register(portToken(BeforeToolHook), {
    useValue: new StampMemoryHook({
      directories: [memoryDirectories.user, memoryDirectories.project],
      clock: container.resolve(portToken(ClockPort)),
    }),
  })

  const models = modelCatalogue({
    adapters: [
      new AnthropicAdapter({ credentials, cards: cardsForProvider(ANTHROPIC_PROVIDER_ID) }),
      new OpenAiAdapter({ credentials, cards: cardsForProvider(OPENAI_PROVIDER_ID) }),
      new OpenRouterAdapter({ credentials, cards: cardsForProvider(OPENROUTER_PROVIDER_ID) }),
      new InferenceAdapter({ credentials, cards: cardsForProvider(INFERENCE_PROVIDER_ID) }),
    ],
    accounts: await accountStore.list(),
  })

  const model = selectableModel({
    catalogue: models,
    initial: launchSelection({
      requested: { model: config.model },
      settled,
      catalogue: models,
    }),
  })

  const pinnedByFlag = modelPinned({ requested: { model: config.model }, catalogue: models })

  const answeringCard = () => models.cardFor(model.choice().ref)

  const cardPinnedTo = (pinned: string | undefined) => {
    if (pinned === undefined) return answeringCard()

    const ref = parseRef(pinned)
    return ref === undefined ? undefined : models.cardFor(ref)
  }

  container.register(LanguageModelToken, { useValue: model.model })
  container.register(ModelCardSourceToken, {
    useValue: () => models.cardFor(model.choice().ref),
  })

  const database = await openAtlasDatabase({
    databaseUrl: launchValue(ESettingId.DatabaseUrl) ?? atlasDatabaseUrl(),
  })
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
    reachableModelIds: knownRefs(models),
    modelIsUsable: (modelId) => {
      const ref = parseRef(modelId)
      return ref !== undefined && models.cardFor(ref) !== undefined
    },
    subagentModelId: launchValue(ESettingId.SubagentModel),
  })

  const log = container.resolve(portToken(EventLogPort))
  const ids = container.resolve(portToken(IdPort))
  const threads = container.resolve(portToken(ThreadStorePort))
  const ledger = container.resolve(portToken(TurnLedgerPort))

  container.register(HookMishapReporterToken, {
    useValue: (mishap: HookMishap) =>
      notify({
        key: `hook:${mishap.label}`,
        tone: ENoticeTone.Warn,
        ttlMs: NOTICE_WARN_MS,
        text: `hook ${mishap.label} ${mishap.detail}`,
      }),
  })

  const plugins = await assemblePlugins({
    container,
    cwd: config.cwd,
    atlasHome: atlasDirectory(),
  })
  for (const refusal of [...plugins.refused, ...plugins.unreadable]) {
    notify({
      key: `plugin:${refusal.id ?? '?'}`,
      tone: ENoticeTone.Warn,
      ttlMs: NOTICE_WARN_MS,
      text: `plugin refused: ${refusal.id ?? '?'} — ${'reason' in refusal ? refusal.reason : refusal.detail}`,
    })
  }

  const tools = () => container.resolve(portToken(ToolRegistry)).declarations()
  const modelPort = faultInjected(container.resolve(portToken(ModelPort)))
  const prompts = container.resolve(portToken(PromptRegistry))
  const compiledPrompt = ({ projectDirectory }: { projectDirectory: string }) =>
    prompts.compile(
      promptContextFor({
        agent: EPromptAgent.Main,
        provider: modelPort.identity,
        model: promptModelOf(answeringCard()),
        projectDirectory,
      }),
    )
  const shells = container.resolve(portToken(ShellRegistryPort))
  const agents = container.resolve(portToken(AgentRegistryPort))
  const services = container.resolve(portToken(ServiceRegistryPort))

  const channel = createDeltaChannel()
  const pending = createPendingQueue()

  let activeThread: ActiveConversation | null = null

  const titlerModel = createAnthropicOauthModel({ credentials, modelId: TITLER_MODEL_ID })
  const summariserModel = createAnthropicOauthModel({ credentials, modelId: SUMMARISER_MODEL_ID })
  const tldrModel = createAnthropicOauthModel({ credentials, modelId: TLDR_MODEL_ID })

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
    await Promise.all([shells.closeAll(), agents.closeAll(), services.closeAll()])

    for (const source of [shells, agents, services]) {
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

  const runningServices = () =>
    services
      .list()
      .filter((service) => service.status === EServiceStatus.Running)
      .map((service) => ({
        serviceId: service.serviceId,
        command: service.command,
        description: service.description,
        logPath: service.logPath,
      }))

  const drainNotices = async ({
    threadId,
  }: {
    threadId: ThreadId
  }): Promise<readonly EventDraft[]> => [
    ...shells.drainNotifications({ threadId }),
    ...agents.drainNotifications({ threadId }),
    ...services.drainNotifications({ threadId }),
  ]

  const turn: TurnDeps = {
    log,
    model: modelPort,
    ids,
    assembly: defaultPipeline({
      prompt: compiledPrompt,
      launchDirectory: config.cwd,
      runningShells,
      runningAgents,
      runningServices,
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

  const pinnedModel = ({ modelId }: { modelId: string }): ReturnType<ProviderAdapter['model']> => {
    const ref = parseRef(modelId)
    const card = ref === undefined ? undefined : models.cardFor(ref)
    const adapter = ref === undefined ? undefined : models.adapterFor(ref.providerId)
    if (card === undefined || adapter === undefined)
      throw new Error(`no provider adapter can answer for ${modelId}`)

    return adapter.model({ card, effort: () => model.choice().effort })
  }

  const modelFor = pinnedModelSource({
    subagentModelId: launchValue(ESettingId.SubagentModel),
    inherited: () => modelPort,
    build: ({ modelId }) =>
      faultInjected(
        new AiSdkModelPort({
          model: pinnedModel({ modelId }),
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
      channel,
      drainNotices,
      modelFor,
      assemblyFor: ({ agentType }) =>
        defaultPipeline({
          prompt: ({ projectDirectory }) =>
            subAgentPrompt({
              prompts,
              agentType,
              provider: modelPort.identity,
              model: promptModelOf(
                cardPinnedTo(agentType.model ?? launchValue(ESettingId.SubagentModel)),
              ),
              projectDirectory,
            }),
          launchDirectory: config.cwd,
          runningShells,
          runningServices,
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
    secrets: container.resolve(SecretsStoreToken),
    skills: skillRegistry.all(),
    skillRegistry,
    agentTypes,
    pluginProjections: plugins.projections,
    pluginSurfaces: plugins.surfaces,
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
    services,
    mcp: () => mcp.servers(),
    /**
     * Drafts append only to a thread the store already knows: a conversation nobody has spoken in
     * is opened by its first turn, and an OnThreadOpen draft must not open it early.
     */
    threadOpened: async ({ threadId, projectDirectory }) => {
      const chain = container.resolve(HookChainToken)
      const drafts = await chain.onThreadOpen({ threadId, projectDirectory })
      if (drafts.length === 0) return
      if ((await threads.find({ threadId })) === undefined) return

      await log.append({ threadId, runId: ids.nextRunId(), drafts })
    },
    model,
    modelPinned: pinnedByFlag,
    models,
    close: async () => {
      usage.dispose()
      await recordTeardownEndings().catch(() => undefined)
      await disposeAll({ container })
    },
    runner: (() => {
      const publishing = new PublishingTurnRunner({ channel, deps: turn })
      if (!toggleValueOf({ resolution: settled, id: ESettingId.TldrFooter })) return publishing

      return new TldrTurnRunner({
        inner: publishing,
        log: withDeltaPublishing({ log, channel }),
        ids,
        model: tldrModel,
        modelId: TLDR_MODEL_ID,
        feed: tldrFeed,
        onMishap: () =>
          notify({ tone: ENoticeTone.Warn, text: 'Could not write the tl;dr footer for that turn.' }),
      })
    })(),
  }
}
