import {
  AccountUsagePort,
  ATLAS_SETTINGS,
  EEffort,
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
  type ModelPort,
  type ModelStepResult,
  type SettingsDocument,
} from '@dltech/atlas-core'
import type { EventDraft } from '@dltech/atlas-core'

import {
  AccountsService,
  builtinOauthClients,
  createAccountUsageService,
  createDeltaChannel,
  memoryAccountStore,
  createSettingsService,
  MemorySettingsStore,
  ModelStreamError,
  PublishingTurnRunner,
  RandomIds,
  ShellRegistryPort,
  SystemClock,
  type DeltaChannel,
  type DiscoveredSkill,
  type ShellSnapshot,
} from '@dltech/atlas-harness'

import { FileBrowser } from '@dltech/atlas-harness'

import { createPendingQueue } from '../../store'
import type { AtlasApp } from '../compose'
import type { ActiveConversation } from '../resume-hint'
import { heldChoice } from '../model-selection'
import { DEFAULT_MODEL_ID, EOpenMode, type AtlasConfig } from '../config'
import {
  fakeThreadStore,
  fakeEventLog,
  fakeLedger,
  type FakeThreadStore,
  type FakeEventLog,
  type FakeLedger,
} from './fake-backend'

export const FAKE_CONFIG: AtlasConfig = {
  modelId: 'claude-haiku-4-5-20251001',
  databaseUrl: 'file::memory:',
  keychainService: undefined,
  thinkingBudgetTokens: 2048,
  open: { mode: EOpenMode.New },
  cwd: '/Users/dennis/Developer/atlas',
}

const CREDENTIAL: Credential = {
  kind: EAuthKind.Oauth,
  accountId: toAccountId('acc_fake'),
  accessToken: 'not-a-real-token',
  expiresAt: '2099-01-01T00:00:00.000Z',
}

export const alwaysAuthorised = (): CredentialPort => ({ read: async () => CREDENTIAL })

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
  place: (snapshot: ShellSnapshot) => void
  print: (args: { shellId: string; text: string }) => void
  announce: (snapshot: ShellSnapshot) => void
  readonly killed: readonly string[]
}

const NO_NOTICES: readonly ShellSnapshot[] = Object.freeze([])

export function fakeShellRegistry(): FakeShells {
  const snapshots: ShellSnapshot[] = []
  const printed = new Map<string, string>()
  const killed: string[] = []
  const listeners = new Set<() => void>()
  let ended: readonly ShellSnapshot[] = NO_NOTICES

  const settle = (next: readonly ShellSnapshot[]): void => {
    ended = next
    for (const listener of [...listeners]) listener()
  }

  const find = (shellId: string): ShellSnapshot | undefined =>
    snapshots.find((snapshot) => snapshot.shellId === shellId)

  return {
    get killed() {
      return killed
    },

    place: (snapshot) => {
      snapshots.push(snapshot)
    },

    print: ({ shellId, text }) => {
      printed.set(shellId, text)
    },

    announce: (snapshot) => {
      snapshots.push(snapshot)
      settle([...ended, snapshot])
    },

    start: () => ({ ok: false, reason: 'the fake registry starts no processes' }),

    read: ({ shellId }) => {
      const snapshot = find(shellId)
      if (snapshot === undefined) return { ok: false, reason: `no shell ${shellId}` }
      return {
        ok: true,
        snapshot,
        delta: { text: '', droppedCharacters: 0, remainingCharacters: 0 },
      }
    },

    peek: ({ shellId }) =>
      find(shellId) === undefined ? undefined : (printed.get(shellId) ?? `output of ${shellId}`),

    kill: ({ shellId }) => {
      const snapshot = find(shellId)
      if (snapshot === undefined) return { ok: false, reason: `no shell ${shellId}` }
      killed.push(shellId)
      return { ok: true, snapshot }
    },

    list: () => snapshots,

    drainNotifications: () => {
      const handed = ended
      if (handed.length === 0) return []

      settle(NO_NOTICES)
      return handed.map((snapshot): EventDraft => ({
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

    pendingNotices: () => ended,

    onNotice: (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },

    forgetNotices: () => {
      if (ended.length === 0) return
      settle(NO_NOTICES)
    },

    closeAll: async () => {},
  }
}

export type FakeApp = AtlasApp & {
  channel: DeltaChannel
  shells: FakeShells
  log: FakeEventLog
  threads: FakeThreadStore
  ledger: FakeLedger
  readonly turnsDriven: number
  readonly titled: readonly string[]
}

export function fakeApp(args: {
  model: ModelPort
  settings?: SettingsDocument
  names?: string | null
  summarises?: string | null
  summariseDelayMs?: number
  skills?: readonly DiscoveredSkill[]
  workspaceRoot?: string
}): FakeApp {
  const channel = createDeltaChannel()
  const log = fakeEventLog()
  const threads = fakeThreadStore({ log })
  const ids = new RandomIds()
  const ledger = fakeLedger()
  const pending = createPendingQueue()
  const shells = fakeShellRegistry()
  const runner = new PublishingTurnRunner({
    channel,
    deps: {
      log,
      model: args.model,
      ids,
      assembly: defaultPipeline({ prompt: () => EMPTY_PROMPT, projectDirectory: FAKE_CONFIG.cwd }),
      spend: { ledger, clock: new SystemClock() },
      drainPending: async () =>
        pending.drain().map((text): EventDraft => ({ type: 'user-said', text })),
    },
  })

  let turnsDriven = 0
  let marked: ActiveConversation | null = null
  const titled: string[] = []

  return {
    skills: args.skills ?? [],
    files: new FileBrowser({ root: args.workspaceRoot ?? FAKE_CONFIG.cwd }),
    accounts: fakeAccounts(),
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
    model: heldChoice({ modelId: FAKE_CONFIG.modelId ?? DEFAULT_MODEL_ID, effort: EEffort.Medium }),
    settings: createSettingsService({
      definitions: ATLAS_SETTINGS,
      user: new MemorySettingsStore({
        label: '~/.atlas/settings.json',
        ...(args.settings === undefined ? {} : { document: args.settings }),
      }),
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
