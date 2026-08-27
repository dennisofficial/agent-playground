import { afterEach, describe, expect, it } from 'bun:test'

import { EEffort } from '@dltech/atlas-core'

import { KeychainCredentialPort, createSecurityKeychainReader } from '../../credentials'
import { ETurnStatus, buildHarness, type AtlasHarness } from '../../loop'
import { createTempDatabase, type TempDatabase } from '../../loop/__tests__/temp-database'
import { SystemClock } from '../../store'
import { createAnthropicOauthModel } from '../anthropic-oauth'
import { anthropicThinkingOptions } from '../anthropic-thinking'
import { bodyOnlyRecordingPassthroughFetch, type BodyOnlyRecordingFetch } from './recording-fetch'

export const LIVE_ANTHROPIC_FLAG = 'ATLAS_LIVE_ANTHROPIC'

const liveRunRequested = (): boolean => process.env[LIVE_ANTHROPIC_FLAG] === '1'

const liveModelId = (): string =>
  process.env.ATLAS_LIVE_ANTHROPIC_MODEL ?? 'claude-haiku-4-5-20251001'

const ADAPTIVE_LIVE_MODEL = 'claude-opus-5'

const opened: { harness: AtlasHarness; temp: TempDatabase }[] = []

async function openLiveHarness(
  modelId: string = liveModelId(),
): Promise<{ harness: AtlasHarness; recorder: BodyOnlyRecordingFetch }> {
  const recorder = bodyOnlyRecordingPassthroughFetch()
  const temp = createTempDatabase()

  const harness = await buildHarness({
    databaseUrl: temp.databaseUrl,
    model: createAnthropicOauthModel({
      credentials: new KeychainCredentialPort({
        reader: createSecurityKeychainReader(),
        clock: new SystemClock(),
      }),
      modelId,
      providerOptions: anthropicThinkingOptions({ modelId, effort: EEffort.High }),
      fetch: recorder.fetch,
    }),
  })

  opened.push({ harness, temp })
  return { harness, recorder }
}

const assistantText = (parts: readonly { type: string }[]): string =>
  parts
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text' && 'text' in part)
    .map((part) => part.text)
    .join('')

const reasoningText = (parts: readonly { type: string }[]): string =>
  parts
    .filter((part): part is { type: 'reasoning'; text: string } => part.type === 'reasoning' && 'text' in part)
    .map((part) => part.text)
    .join('')

const reasoningSignature = (parts: readonly { type: string }[]): string | undefined => {
  for (const part of parts) {
    if (part.type !== 'reasoning' || !('providerOptions' in part)) continue
    const options: unknown = part.providerOptions
    if (options === null || typeof options !== 'object') continue
    const anthropic = Object.entries(options).find(([namespace]) => namespace === 'anthropic')?.[1]
    if (anthropic === null || typeof anthropic !== 'object') continue
    const signature = Object.entries(anthropic).find(([key]) => key === 'signature')?.[1]
    if (typeof signature === 'string' && signature.length > 0) return signature
  }
  return undefined
}

const thinkingSignaturesIn = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.flatMap(thinkingSignaturesIn)
  if (value === null || typeof value !== 'object') return []

  const entries = Object.entries(value)
  const isThinkingBlock = entries.some(([key, held]) => key === 'type' && held === 'thinking')
  const own = isThinkingBlock
    ? entries.flatMap(([key, held]) => (key === 'signature' && typeof held === 'string' ? [held] : []))
    : []

  return [...own, ...entries.flatMap(([, held]) => thinkingSignaturesIn(held))]
}

const failureOf = (outcome: { status: ETurnStatus; message?: string }): string =>
  outcome.status === ETurnStatus.Failed ? `${outcome.status}: ${outcome.message ?? ''}` : outcome.status

afterEach(async () => {
  for (const entry of opened.splice(0)) {
    await entry.harness.close()
    entry.temp.discard()
  }
})

describe.skipIf(!liveRunRequested())('a real turn against Anthropic on the subscription credential', () => {
  it('answers with a real reply', async () => {
    const { harness } = await openLiveHarness()
    const thread = await harness.threads.create({})

    const outcome = await harness.runner.say({
      threadId: thread.id,
      text: 'Reply with exactly the single word ATLAS and nothing else.',
    })

    expect(failureOf(outcome)).toBe(ETurnStatus.Completed)

    const events = await harness.log.read({ threadId: thread.id })
    const reply = events.at(-1)
    expect(assistantText(reply?.type === 'assistant-said' ? reply.parts : [])).toContain('ATLAS')
  }, 120_000)

  it('carries the thinking signature it was handed back into the next request unchanged', async () => {
    const { harness, recorder } = await openLiveHarness()
    const thread = await harness.threads.create({})

    const first = await harness.runner.say({
      threadId: thread.id,
      text: 'Think about which of 17 and 19 is larger, then reply with just that number.',
    })
    expect(failureOf(first)).toBe(ETurnStatus.Completed)

    const afterFirst = await harness.log.read({ threadId: thread.id })
    const thought = afterFirst.at(-1)
    const signature = reasoningSignature(thought?.type === 'assistant-said' ? thought.parts : [])
    if (signature === undefined) throw new Error('the live reply carried no thinking signature')

    const second = await harness.runner.say({
      threadId: thread.id,
      text: 'Now reply with exactly the single word AGAIN and nothing else.',
    })
    expect(failureOf(second)).toBe(ETurnStatus.Completed)

    expect(thinkingSignaturesIn(recorder.requests[1]?.body)).toContain(signature)
  }, 180_000)

  it('is handed thinking it can show, not a signature over an empty text', async () => {
    const { harness } = await openLiveHarness(ADAPTIVE_LIVE_MODEL)
    const thread = await harness.threads.create({})

    const outcome = await harness.runner.say({
      threadId: thread.id,
      text: 'Work out 27 * 43 in your head step by step, then reply with just the product.',
    })
    expect(failureOf(outcome)).toBe(ETurnStatus.Completed)

    const events = await harness.log.read({ threadId: thread.id })
    const thought = events.at(-1)
    const parts = thought?.type === 'assistant-said' ? thought.parts : []
    expect(parts.some((part) => part.type === 'reasoning')).toBe(true)
    expect(reasoningText(parts).trim().length).toBeGreaterThan(0)
  }, 180_000)
})
