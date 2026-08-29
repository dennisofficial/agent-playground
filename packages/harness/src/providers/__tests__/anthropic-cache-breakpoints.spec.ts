import { describe, expect, it } from 'bun:test'
import { streamText } from 'ai'

import {
  assemble,
  defaultAnnotators,
  defaultRules,
  ECacheTtl,
  type CompiledPrompt,
  estimateTokens,
  stampDrafts,
  toThreadId,
  toEventId,
  toRunId,
  type CredentialPort,
  type Event,
  type EventDraft,
} from '@dltech/atlas-core'

import { toInstructions } from '../../model/instructions'
import { toModelMessages } from '../../model/message-conversion'
import { toProviderPrompt } from '../../model/provider-prompt'
import { ANTHROPIC_PROVIDER_ID, createAnthropicOauthModel } from '../anthropic-oauth'
import { credentialsHandingOut, oauthCredential } from '../../credentials/testing'
import { recordingFetch, streamedText } from './recording-fetch'

const PROJECT_DIRECTORY = '/w'

const MODEL_ID = 'claude-opus-5'

const credentials: CredentialPort = credentialsHandingOut(
  oauthCredential({ accessToken: 'token' }),
)

const log = (drafts: readonly EventDraft[]): Event[] =>
  stampDrafts({
    drafts,
    envelopes: drafts.map((_draft, index) => ({
      id: toEventId(`event-${index + 1}`),
      seq: index + 1,
      threadId: toThreadId('thread-fixture'),
      runId: toRunId('run-fixture'),
      depth: 0,
      at: '2026-01-01T00:00:00.000Z',
    })),
  })

const exchange = log([
  { type: 'user-said', text: 'what does this repo do?' },
  { type: 'assistant-said', parts: [{ type: 'text', text: 'it is a coding agent harness' }] },
  { type: 'user-said', text: 'and now?' },
])

const FIXTURE_PROMPT: CompiledPrompt = {
  blocks: [{ text: 'You are Atlas.' }, { text: 'The project directory is /w.' }],
  parts: [
    { id: 'fixture.identity', text: 'You are Atlas.', chars: 14 },
    { id: 'fixture.environment', text: 'The project directory is /w.', chars: 28 },
  ],
  skipped: [],
}

type CachedBlock = { cache_control?: { type: string; ttl?: string } }

const sentBody = async (): Promise<{ system: CachedBlock[]; messages: { content: CachedBlock[] }[] }> => {
  const { assembled } = assemble({
    rules: defaultRules({ prompt: () => FIXTURE_PROMPT, projectDirectory: PROJECT_DIRECTORY }),
    annotators: defaultAnnotators(),
    ctx: {
      events: exchange,
      threadId: toThreadId('thread-fixture'),
      step: 0,
      provider: { id: ANTHROPIC_PROVIDER_ID, modelId: MODEL_ID },
      countTokens: estimateTokens,
    },
  })

  const recorder = recordingFetch({ body: streamedText('ok') })
  const prompt = toProviderPrompt({
    assembled,
    provider: { id: ANTHROPIC_PROVIDER_ID, modelId: MODEL_ID },
  })

  await streamText({
    model: createAnthropicOauthModel({ credentials, modelId: MODEL_ID, fetch: recorder.fetch }),
    instructions: toInstructions(prompt.instructions),
    messages: toModelMessages(prompt.messages),
  }).text

  const body = recorder.requests[0]?.body
  if (body === null || typeof body !== 'object') throw new Error('no request body was recorded')
  return body as { system: CachedBlock[]; messages: { content: CachedBlock[] }[] }
}

describe('the breakpoints the default annotators place', () => {
  it('reaches the wire as cache_control on the last system block', async () => {
    const body = await sentBody()
    const system = body.system

    expect(system.length).toBeGreaterThan(1)
    expect(system.slice(0, -1).map((block) => block.cache_control)).not.toContain({ type: 'ephemeral' })
    expect(system[system.length - 1]?.cache_control).toEqual({
      type: 'ephemeral',
      ttl: ECacheTtl.OneHour,
    })
  })

  it('reaches the wire as cache_control on the last conversation block', async () => {
    const body = await sentBody()
    const last = body.messages[body.messages.length - 1]?.content ?? []

    expect(last[last.length - 1]?.cache_control).toEqual({
      type: 'ephemeral',
      ttl: ECacheTtl.FiveMinutes,
    })
  })

  it('stays inside the four breakpoints Anthropic accepts', async () => {
    const body = await sentBody()
    const marked = [...body.system, ...body.messages.flatMap((message) => message.content)].filter(
      (block) => block.cache_control !== undefined,
    )

    expect(marked.length).toBeLessThanOrEqual(4)
  })
})
