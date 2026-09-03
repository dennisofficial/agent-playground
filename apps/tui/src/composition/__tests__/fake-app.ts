import {
  AccountUsagePort,
  ATLAS_SETTINGS,
  EEffort,
  EImageTier,
  catalogOf,
  findCard,
  parseRef,
  defaultPipeline,
  EMPTY_PROMPT,
  EFinishReason,
  type AccountUsage,
  type Chunk,
  type ChunkFilter,
  EAuthKind,
  toAccountId,
  type Credential,
  type CredentialPort,
  type EffortMap,
  type ModelCard,
  type ModelPort,
  type ModelStepResult,
  type SettingsDocument,
  toThreadId,
  type ThreadId,
} from '@dltech/atlas-core'
import type { EventDraft } from '@dltech/atlas-core'

import {
  AccountsService,
  builtinOauthClients,
  createAccountUsageService,
  createDeltaChannel,
  memoryAccountStore,
  createSettingsService,
  ESkillOrigin,
  MemorySecretsStore,
  MemorySettingsStore,
  ModelStreamError,
  parseSkill,
  PublishingTurnRunner,
  RandomIds,
  ShellRegistryPort,
  SkillRegistryPort,
  SystemClock,
  EMPTY_AGENT_TYPE_CATALOG,
  type AgentTypeCatalog,
  type DeltaChannel,
  type DiscoveredSkill,
  type ShellSnapshot,
} from '@dltech/atlas-harness'

import { FileBrowser } from '@dltech/atlas-harness'

import { createPendingQueue } from '../../store'
import { userSaidDraft } from '../user-said'
import type { AtlasApp } from '../compose'
import type { ActiveConversation } from '../resume-hint'
import { heldChoice } from '../model-selection'
import type { ModelCatalogue } from '../providers'
import { DEFAULT_MODEL_REF, EOpenMode, type AtlasConfig } from '../config'
import { fakeAgentRegistry, type FakeAgents } from './fake-agents'
import {
  fakeThreadStore,
  fakeEventLog,
  fakeLedger,
  type FakeThreadStore,
  type FakeEventLog,
  type FakeLedger,
} from './fake-backend'

export const FAKE_CONFIG: AtlasConfig = {
  model: undefined,
  open: { mode: EOpenMode.New },
  cwd: '/workspace/atlas',
}

const fakeCard = (args: {
  providerId: string
  modelId: string
  label: string
  price: number
  effort?: EffortMap | undefined
}): ModelCard => ({
  ref: { providerId: args.providerId, modelId: args.modelId },
  label: args.label,
  api: 'messages',
  contextWindow: 200_000,
  imageTier: EImageTier.HighResolution,
  cost: { inputPerMillion: 1, outputPerMillion: args.price },
  ...(args.effort === undefined ? {} : { effort: args.effort }),
})

const LADDER: EffortMap = {
  [EEffort.Low]: 'low',
  [EEffort.Medium]: 'medium',
  [EEffort.High]: 'high',
}

/**
 * Hand-written rather than the shipped catalogue: these are the rows the overlay tests read back,
 * and a regenerated card list would otherwise rename and reorder them out from under the assertions.
 */
const CLAUDE_CARDS: readonly ModelCard[] = [
  fakeCard({
    providerId: 'anthropic',
    modelId: 'claude-opus-5',
    label: 'opus-5',
    price: 25,
    effort: LADDER,
  }),
  fakeCard({
    providerId: 'anthropic',
    modelId: 'claude-sonnet-5',
    label: 'sonnet-5',
    price: 15,
    effort: LADDER,
  }),
  fakeCard({
    providerId: DEFAULT_MODEL_REF.providerId,
    modelId: DEFAULT_MODEL_REF.modelId,
    label: 'haiku-4-5',
    price: 5,
    effort: LADDER,
  }),
]

const CODEX_CARDS: readonly ModelCard[] = [
  fakeCard({
    providerId: 'openai',
    modelId: 'gpt-5-codex',
    label: 'gpt-5-codex',
    price: 10,
    effort: LADDER,
  }),
]

const FAKE_CATALOG = catalogOf([...CLAUDE_CARDS, ...CODEX_CARDS])

/** Anthropic is keyed and OpenAI is not, so the `⚠ no key` row still has something to say. */
export function fakeCatalogue(): ModelCatalogue {
  return {
    providers: [
      { id: 'anthropic', label: 'Claude Plan', cards: CLAUDE_CARDS },
      { id: 'openai', label: 'Codex Plan', cards: CODEX_CARDS },
    ],
    catalog: FAKE_CATALOG,
    cardFor: (ref) => findCard({ catalog: FAKE_CATALOG, ref }),
    adapterFor: () => undefined,
    reachable: (providerId) => providerId === 'anthropic',
    subscribed: () => true,
    observeAccounts: () => {},
  }
}

const CREDENTIAL: Credential = {
  kind: EAuthKind.Oauth,
  accountId: toAccountId('acc_fake'),
  accessToken: 'not-a-real-token',
  expiresAt: '2099-01-01T00:00:00.000Z',
}

export const alwaysAuthorised = (): CredentialPort => ({
  read: async () => CREDENTIAL,
  discard: async () => {},
})

export const fakeAccounts = (): AccountsService => {
  const clock = new SystemClock()

  return new AccountsService({
    accounts: memoryAccountStore({ clock }),
    clients: builtinOauthClients({ clock }),
  })
}

export type ScriptedReply = { thinking: string; reply: string }

const PIECE = 8

const pieces = (text: string): string[] => {
  const held: string[] = []
  for (let at = 0; at < text.length; at += PIECE) held.push(text.slice(at, at + PIECE))
  return held
}

const chunksOf = (script: ScriptedReply): Chunk[] => [
  { type: 'reasoning-start', id: 'r' },
  ...pieces(script.thinking).map((text): Chunk => ({ type: 'reasoning-delta', id: 'r', text })),
  { type: 'reasoning-end', id: 'r' },
  { type: 'text-start', id: 't' },
  ...pieces(script.reply).map((text): Chunk => ({ type: 'text-delta', id: 't', text })),
  { type: 'text-end', id: 't' },
  { type: 'finish', reason: EFinishReason.Stop },
]

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const partsOf = (said: { thinking: string; reply: string }) => [
  ...(said.thinking.length > 0 ? [{ type: 'reasoning' as const, text: said.thinking }] : []),
  ...(said.reply.length > 0 ? [{ type: 'text' as const, text: said.reply }] : []),
]

export function scriptedModelPort(args: { script: ScriptedReply; perChunkMs?: number }): ModelPort {
  const perChunkMs = args.perChunkMs ?? 0

  return {
    identity: { id: 'scripted', modelId: 'scripted' },

    async step({ signal, onChunk }): Promise<ModelStepResult> {
      const keep: ChunkFilter = onChunk ?? ((chunk) => chunk)
      const said = { thinking: '', reply: '' }

      for (const chunk of chunksOf(args.script)) {
        if (signal.aborted) break

        keep(chunk)
        if (chunk.type === 'reasoning-delta') said.thinking += chunk.text
        if (chunk.type === 'text-delta') said.reply += chunk.text

        await pause(perChunkMs)
      }

      return { parts: partsOf(said), toolCalls: [], finishReason: EFinishReason.Stop }
    },
  }
}

export function failingModelPort(args: { message: string }): ModelPort {
  return {
    identity: { id: 'failing', modelId: 'failing' },

    step(): Promise<ModelStepResult> {
      return Promise.reject(new ModelStreamError({ message: args.message }))
    },
  }
}

const whenAborted = (signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))

export function failingThenStallingModelPort(args: { message: string }): ModelPort {
  let failed = false

  return {
    identity: { id: 'failing-then-stalling', modelId: 'failing-then-stalling' },

    async step({ signal }): Promise<ModelStepResult> {
      if (!failed) {
        failed = true
        throw new ModelStreamError({ message: args.message })
      }

      await whenAborted(signal)
      return { parts: [], toolCalls: [], finishReason: EFinishReason.Stop }
    },
  }
}

export type FakeShells = ShellRegistryPort & {
  place: (snapshot: ShellSnapshot, owner?: ThreadId) => void
  print: (args: { shellId: string; text: string }) => void
  announce: (snapshot: ShellSnapshot, owner?: ThreadId) => void
  readonly killed: readonly string[]
}

const NO_NOTICES: readonly ShellSnapshot[] = Object.freeze([])

export const FAKE_SHELL_OWNER = toThreadId('opened-thread')

type OwnedShell = { snapshot: ShellSnapshot; threadId: ThreadId }

export function fakeShellRegistry(): FakeShells {
  const owned: OwnedShell[] = []
  const printed = new Map<string, string>()
  const killed: string[] = []
  const listeners = new Set<() => void>()
  let ended: readonly OwnedShell[] = []

  const settle = (next: readonly OwnedShell[]): void => {
    ended = next
    for (const listener of [...listeners]) listener()
  }

  const noticedBy = new Map<ThreadId, readonly ShellSnapshot[]>()
  const notices = (threadId: ThreadId): readonly ShellSnapshot[] => {
    const mine = ended.filter((one) => one.threadId === threadId).map((one) => one.snapshot)
    if (mine.length === 0) {
      noticedBy.delete(threadId)
      return NO_NOTICES
    }

    const held = noticedBy.get(threadId)
    if (
      held !== undefined &&
      held.length === mine.length &&
      held.every((snapshot, at) => snapshot === mine[at])
    ) {
      return held
    }

    noticedBy.set(threadId, mine)
    return mine
  }

  const find = (shellId: string, threadId: ThreadId): ShellSnapshot | undefined =>
    owned.find((one) => one.snapshot.shellId === shellId && one.threadId === threadId)?.snapshot

  return {
    get killed() {
      return killed
    },

    place: (snapshot, owner = FAKE_SHELL_OWNER) => {
      owned.push({ snapshot, threadId: owner })
    },

    print: ({ shellId, text }) => {
      printed.set(shellId, text)
    },

    announce: (snapshot, owner = FAKE_SHELL_OWNER) => {
      owned.push({ snapshot, threadId: owner })
      settle([...ended, { snapshot, threadId: owner }])
    },

    start: () => ({ ok: false, reason: 'the fake registry starts no processes' }),

    read: ({ shellId, threadId }) => {
      const snapshot = find(shellId, threadId)
      if (snapshot === undefined) return { ok: false, reason: `no shell ${shellId}` }
      return {
        ok: true,
        snapshot,
        delta: { text: '', droppedCharacters: 0, remainingCharacters: 0 },
      }
    },

    peek: ({ shellId, threadId }) =>
      find(shellId, threadId) === undefined
        ? undefined
        : (printed.get(shellId) ?? `output of ${shellId}`),

    kill: ({ shellId, threadId }) => {
      const snapshot = find(shellId, threadId)
      if (snapshot === undefined) return { ok: false, reason: `no shell ${shellId}` }
      killed.push(shellId)
      return { ok: true, snapshot }
    },

    list: ({ threadId }) =>
      owned.filter((one) => one.threadId === threadId).map((one) => one.snapshot),

    listEverywhere: () => owned.map((one) => one.snapshot),

    threadsAwaitingNotice: () => [...new Set(ended.map((one) => one.threadId))],

    drainNotifications: ({ threadId }) => {
      const handed = ended.filter((one) => one.threadId === threadId)
      if (handed.length === 0) return []

      settle(ended.filter((one) => one.threadId !== threadId))
      return handed.map(({ snapshot }): EventDraft => ({
        type: 'background-shell-ended',
        shellId: snapshot.shellId,
        command: snapshot.command,
        description: snapshot.description,
        status: snapshot.status,
        exitCode: snapshot.exitCode,
        output: `output of ${snapshot.shellId}`,
        droppedCharacters: 0,
        remainingCharacters: 0,
      }))
    },

    pendingNotices: ({ threadId }) => notices(threadId),

    onNotice: (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },

    forgetNotices: ({ threadId }) => {
      const kept = ended.filter((one) => one.threadId !== threadId)
      if (kept.length === ended.length) return
      settle(kept)
    },

    closeAll: async () => {},
  }
}

export type FakeSkills = SkillRegistryPort & {
  place: (skill: DiscoveredSkill) => void
  drop: (name: string) => void
  readonly reloads: number
}

const written = (args: {
  name: string
  summary: string
  userInvocable: boolean
  body: string
}): string =>
  [
    '---',
    `name: ${args.name}`,
    `description: ${args.summary}`,
    `user-invocable: ${args.userInvocable}`,
    '---',
    '',
    args.body,
  ].join('\n')

export function fakeSkill(args: {
  name: string
  summary?: string
  userInvocable?: boolean
  body?: string
}): DiscoveredSkill {
  const name = args.name
  const skill = parseSkill({
    text: written({
      name,
      summary: args.summary ?? `the ${name} skill`,
      userInvocable: args.userInvocable ?? true,
      body: args.body ?? `Behave as ${name} would.`,
    }),
    fallbackName: name,
    origin: ESkillOrigin.User,
  })

  if (skill === undefined) throw new Error(`the fake skill ${name} did not parse`)
  return skill
}

export function fakeSkillRegistry(args: { skills: readonly DiscoveredSkill[] }): FakeSkills {
  const onDisk: DiscoveredSkill[] = [...args.skills]
  let loaded: readonly DiscoveredSkill[] = [...args.skills]
  let reloads = 0

  return {
    get reloads() {
      return reloads
    },

    place: (skill) => {
      onDisk.push(skill)
    },

    drop: (name) => {
      const at = onDisk.findIndex((one) => one.spec.name === name)
      if (at !== -1) onDisk.splice(at, 1)
    },

    all: () => loaded,

    byName: (name) => loaded.find((one) => one.spec.name === name),

    reload: async () => {
      reloads += 1
      loaded = [...onDisk]
      return loaded
    },
  }
}

export type FakeApp = AtlasApp & {
  channel: DeltaChannel
  shells: FakeShells
  agents: FakeAgents
  skillRegistry: FakeSkills
  log: FakeEventLog
  threads: FakeThreadStore
  ledger: FakeLedger
  readonly turnsDriven: number
  readonly titled: readonly string[]
  readonly openedUrls: readonly string[]
  readonly openedDirectories: readonly string[]
}

export function fakeApp(args: {
  model: ModelPort
  settings?: SettingsDocument
  secrets?: Record<string, string>
  names?: string | null
  summarises?: string | null
  summariseDelayMs?: number
  skills?: readonly DiscoveredSkill[]
  agentTypes?: AgentTypeCatalog
  workspaceRoot?: string
}): FakeApp {
  const channel = createDeltaChannel()
  const log = fakeEventLog()
  const threads = fakeThreadStore({ log })
  const ids = new RandomIds()
  const ledger = fakeLedger()
  const pending = createPendingQueue()
  const shells = fakeShellRegistry()
  const agents = fakeAgentRegistry()
  const skillRegistry = fakeSkillRegistry({ skills: args.skills ?? [] })
  const runner = new PublishingTurnRunner({
    channel,
    deps: {
      log,
      model: args.model,
      ids,
      assembly: defaultPipeline({ prompt: () => EMPTY_PROMPT, launchDirectory: FAKE_CONFIG.cwd }),
      spend: { ledger, clock: new SystemClock() },
      drainPending: async () => pending.drain().map(userSaidDraft),
    },
  })

  let turnsDriven = 0
  let marked: ActiveConversation | null = null
  const titled: string[] = []
  const openedUrls: string[] = []
  const openedDirectories: string[] = []

  return {
    skills: skillRegistry.all(),
    skillRegistry,
    agentTypes: args.agentTypes ?? EMPTY_AGENT_TYPE_CATALOG,
    pluginProjections: [],
    pluginSurfaces: [],
    mcp: () => [],
    threadOpened: async ({ projectDirectory }) => {
      openedDirectories.push(projectDirectory)
    },
    files: new FileBrowser({ root: args.workspaceRoot ?? FAKE_CONFIG.cwd }),
    accounts: fakeAccounts(),
    openUrl: (url: string) => {
      openedUrls.push(url)
    },
    openedUrls,
    openedDirectories,
    usage: createAccountUsageService({
      usage: new (class extends AccountUsagePort {
        async read(): Promise<AccountUsage | null> {
          return null
        }
      })(),
    }),

    get turnsDriven() {
      return turnsDriven
    },

    get titled() {
      return titled
    },

    ledger,

    markActiveThread: (active) => {
      marked = active
    },

    activeThread: () => marked,

    titler: async ({ text }) => {
      titled.push(text)
      return args.names ?? null
    },

    summarise: async ({ signal }) => {
      const delay = args.summariseDelayMs ?? 0
      if (delay > 0) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, delay)
          signal?.addEventListener('abort', () => {
            clearTimeout(timer)
            reject(new Error('aborted'))
          })
        })
      }
      return args.summarises ?? null
    },

    config: FAKE_CONFIG,
    workspace: { workspace: FAKE_CONFIG.cwd, repo: null },
    credentials: alwaysAuthorised(),
    channel,
    log,
    threads,
    ids,
    pending,
    shells,
    agents,
    model: heldChoice({
      ref: parseRef(FAKE_CONFIG.model ?? '') ?? DEFAULT_MODEL_REF,
      effort: EEffort.Medium,
    }),
    modelPinned: false,
    models: fakeCatalogue(),
    settings: createSettingsService({
      definitions: ATLAS_SETTINGS,
      user: new MemorySettingsStore({
        label: '~/.atlas/settings.json',
        ...(args.settings === undefined ? {} : { document: args.settings }),
      }),
    }),
    secrets: new MemorySecretsStore({
      label: '~/.atlas/secrets.json',
      ...(args.secrets === undefined ? {} : { secrets: args.secrets }),
    }),
    close: async () => {},
    runner: {
      say: (call) => runner.say(call),
      resume: (call) => {
        turnsDriven += 1
        return runner.resume(call)
      },
      runTurn: (call) => {
        turnsDriven += 1
        return runner.runTurn(call)
      },
    },
  }
}
