import { describe, expect, it } from 'bun:test'

import {
  defaultPipeline,
  EMPTY_PROMPT,
  EStage,
  type AfterTurn,
  type BeforeRequest,
  type BeforeStep,
  type Message,
  type OnChunk,
} from '@dltech/atlas-core'

import { buildHarness, ETurnStatus } from '..'
import { createDeltaChannel, PublishingTurnRunner, type ChannelSignal } from '../../channel'
import { HookChain } from '../../hooks/registry'
import { interruptibleModel } from '../../model/testing/interruptible-model'
import { FIXTURE_DOCTRINE } from './fixture-prompt'
import { createTempDatabase } from './temp-database'
import { keepOpen, openHooked } from './hooked-turn'

const PROJECT_DIRECTORY = '/w'

const nudging = (text: string): AfterTurn => async () => ({
  drafts: [{ type: 'nudge', text, lifetimeSteps: 1 }],
})

const publishedDeltas = (signals: readonly ChannelSignal[]): string[] =>
  signals.flatMap((signal) =>
    signal.type === 'chunk' && signal.chunk.type === 'text-delta' ? [signal.chunk.text] : [],
  )

describe('BeforeStep', () => {
  it('rewrites the assembled prompt the model is then sent', async () => {
    const insistOnBrevity: BeforeStep = async ({ assembled }) => ({
      ...assembled,
      system: [...assembled.system, { text: 'Answer in one word.' }],
    })

    const { runner, harness, model } = await openHooked({
      script: [{ text: 'auth' }],
      hooks: new HookChain({
        beforeStep: [{ name: 'insistOnBrevity', order: { stage: EStage.Policy, nudge: 0 }, run: insistOnBrevity }],
      }),
    })
    const thread = await harness.threads.create({})

    const outcome = await runner.say({ threadId: thread.id, text: 'what changed?' })

    expect(outcome.status).toBe(ETurnStatus.Completed)
    expect(model.doStreamCalls[0]?.prompt.slice(0, 2)).toEqual([
      { role: 'system', content: FIXTURE_DOCTRINE },
      { role: 'system', content: 'Answer in one word.' },
    ])
  })

  it('is checked by exchangeFaults, so a rewrite the provider would reject fails the turn unsent', async () => {
    const blankUserTurn: Message = { role: 'user', content: [{ type: 'text', text: '' }] }
    const blankEveryText: BeforeStep = async ({ assembled }) => ({
      ...assembled,
      messages: assembled.messages.map((entry) => ({ ...entry, message: blankUserTurn })),
    })

    const { runner, harness, model } = await openHooked({
      script: [{ text: 'unreachable' }],
      hooks: new HookChain({
        beforeStep: [{ name: 'blankEveryText', order: { stage: EStage.Policy, nudge: 0 }, run: blankEveryText }],
      }),
    })
    const thread = await harness.threads.create({})

    const outcome = await runner.say({ threadId: thread.id, text: 'what changed?' })

    expect(outcome.status).toBe(ETurnStatus.Failed)
    expect(outcome.status === ETurnStatus.Failed ? outcome.message : '').toMatch(/text block holding no text/)
    expect(model.doStreamCalls).toHaveLength(0)
  })
})

describe('BeforeRequest', () => {
  it('rewrites what is sent and leaves no trace in the log at all', async () => {
    const shout: BeforeRequest = async (prompt) => ({
      ...prompt,
      instructions: [...prompt.instructions, { text: 'SHOUT' }],
    })

    const { runner, harness, model } = await openHooked({
      script: [{ text: 'AUTH' }],
      hooks: new HookChain({
        beforeRequest: [{ name: 'shout', order: { stage: EStage.Policy, nudge: 0 }, run: shout }],
      }),
    })
    const thread = await harness.threads.create({})

    await runner.say({ threadId: thread.id, text: 'what changed?' })

    expect(model.doStreamCalls[0]?.prompt.slice(0, 2)).toEqual([
      { role: 'system', content: FIXTURE_DOCTRINE },
      { role: 'system', content: 'SHOUT' },
    ])
    const events = await harness.log.read({ threadId: thread.id })
    expect(events.map((event) => event.type)).toEqual(['user-said', 'assistant-said'])
  })
})

describe('AfterTurn', () => {
  it('appends what its hooks return, in stage order, once the turn has completed', async () => {
    const { runner, harness } = await openHooked({
      script: [{ text: 'auth' }],
      hooks: new HookChain({
        afterTurn: [
          { name: 'observed', order: { stage: EStage.Observe, nudge: 0 }, run: nudging('observed') },
          { name: 'guarded', order: { stage: EStage.Guard, nudge: 0 }, run: nudging('guarded') },
        ],
      }),
    })
    const thread = await harness.threads.create({})

    await runner.say({ threadId: thread.id, text: 'what changed?' })

    const events = await harness.log.read({ threadId: thread.id })
    expect(events.map((event) => event.type)).toEqual(['user-said', 'assistant-said', 'nudge', 'nudge'])
    expect(events.flatMap((event) => (event.type === 'nudge' ? [event.text] : []))).toEqual([
      'guarded',
      'observed',
    ])
  })

  it('runs once per turn, not once per model step, so a tool round trip does not double it', async () => {
    const { runner, harness } = await openHooked({
      script: [{ text: 'looking', calls: [{ callId: 'call-1', name: 'touch', input: {} }] }, { text: 'auth' }],
      withTools: true,
      hooks: new HookChain({
        afterTurn: [{ name: 'observed', order: { stage: EStage.Observe, nudge: 0 }, run: nudging('observed') }],
      }),
    })
    const thread = await harness.threads.create({})

    await runner.say({ threadId: thread.id, text: 'what changed?' })

    const events = await harness.log.read({ threadId: thread.id })
    expect(events.filter((event) => event.type === 'nudge')).toHaveLength(1)
    expect(events.at(-1)?.type).toBe('nudge')
  })
})

describe('OnChunk against the delta channel', () => {
  it('composes with the publisher rather than replacing it: kept deltas still stream, dropped ones do not', async () => {
    const redact: OnChunk = async (chunk) => {
      if (chunk.type === 'text-delta' && chunk.text.includes('sk-')) return null
      return chunk
    }

    const hooks = new HookChain({
      onChunk: [{ name: 'secret-redaction', order: { stage: EStage.Guard, nudge: 0 }, run: redact }],
    })

    const temp = createTempDatabase()
    const harness = await buildHarness({
      databaseUrl: temp.databaseUrl,
      model: interruptibleModel({ head: 'auth and ', tail: 'sk-leak', chunkDelayInMs: 0 }),
      hooks,
    })
    keepOpen({ harness, temp })

    const channel = createDeltaChannel()
    const seen: ChannelSignal[] = []
    const thread = await harness.threads.create({})
    channel.subscribe({ threadId: thread.id, listener: (signal) => void seen.push(signal) })

    const runner = new PublishingTurnRunner({
      channel,
      deps: { log: harness.log, model: harness.model, ids: harness.ids, assembly: defaultPipeline({ prompt: () => EMPTY_PROMPT, projectDirectory: PROJECT_DIRECTORY }), hooks },
    })

    const outcome = await runner.say({ threadId: thread.id, text: 'what changed?' })

    expect(outcome.status).toBe(ETurnStatus.Completed)
    expect(publishedDeltas(seen)).toEqual(['auth and '])
    expect(seen.some((signal) => signal.type === 'step-started')).toBe(true)
  })
})
