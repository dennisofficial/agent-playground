import {
  defaultRules,
  EFinishReason,
  type Chunk,
  type ChunkFilter,
  type Credential,
  type CredentialPort,
  type ModelPort,
  type ModelStepResult,
} from '@dltech/atlas-core'
import {
  createDeltaChannel,
  createPublishingTurnRunner,
  ModelStreamError,
  RandomIds,
  type DeltaChannel,
} from '@dltech/atlas-harness'

import type { AtlasApp } from '../compose'
import type { AtlasConfig } from '../config'
import { fakeBranchStore, fakeEventLog, type FakeBranchStore, type FakeEventLog } from './fake-backend'

export const FAKE_CONFIG: AtlasConfig = {
  modelId: 'claude-haiku-4-5-20251001',
  databaseUrl: 'file::memory:',
  keychainService: undefined,
  thinkingBudgetTokens: 2048,
  freshConversation: false,
  cwd: '/Users/dennis/Developer/atlas',
}

const CREDENTIAL: Credential = {
  accessToken: 'not-a-real-token',
  expiresAt: '2099-01-01T00:00:00.000Z',
}

export const alwaysAuthorised = (): CredentialPort => ({ read: async () => CREDENTIAL })

export type ScriptedReply = { thinking: string; reply: string }

const PIECE = 8

const pieces = (text: string): string[] => {
  const held: string[] = []
  for (let at = 0; at < text.length; at += PIECE) held.push(text.slice(at, at + PIECE))
  return held
}

const chunksOf = (script: ScriptedReply): Chunk[] => [
  { type: 'reasoning-start', id: 'r' },
  ...pieces(script.thinking).map(
    (text): Chunk => ({ type: 'reasoning-delta', id: 'r', text }),
  ),
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

export function scriptedModelPort(args: {
  script: ScriptedReply
  perChunkMs?: number
}): ModelPort {
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

export type FakeApp = AtlasApp & {
  channel: DeltaChannel
  log: FakeEventLog
  branches: FakeBranchStore
}

export function fakeApp(args: { model: ModelPort }): FakeApp {
  const channel = createDeltaChannel()
  const log = fakeEventLog()
  const branches = fakeBranchStore()
  const ids = new RandomIds()

  return {
    config: FAKE_CONFIG,
    credentials: alwaysAuthorised(),
    channel,
    log,
    branches,
    ids,
    close: async () => {},
    runner: createPublishingTurnRunner({
      channel,
      deps: { log, model: args.model, ids, rules: defaultRules() },
    }),
  }
}
