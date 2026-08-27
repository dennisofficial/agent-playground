import { afterEach, describe, expect, it } from 'bun:test'

import { defaultPipeline, type Event, type EventOfType } from '@dltech/atlas-core'

import type { LanguageModel } from 'ai'

import { buildHarness, ETurnStatus, type AtlasHarness, type TurnDeps } from '../../loop'
import { interruptibleModel } from '../../model/testing/interruptible-model'
import { createTempDatabase, type TempDatabase } from '../../loop/__tests__/temp-database'
import { scriptedModel, type ScriptedStep } from '../../model/testing/scripted-model'
import { createDeltaChannel, EStepEnd, PublishingTurnRunner, type ChannelSignal } from '..'
import { assistantEvent, firstStepId, recorder, stepEnded } from './signals'

const opened: { harness: AtlasHarness; temp: TempDatabase }[] = []

afterEach(async () => {
  for (const entry of opened.splice(0)) {
    await entry.harness.close()
    entry.temp.discard()
  }
})

async function openHarnessWith(model: LanguageModel): Promise<AtlasHarness> {
  const temp = createTempDatabase()
  const harness = await buildHarness({ databaseUrl: temp.databaseUrl, model })
  opened.push({ harness, temp })
  return harness
}

const openHarness = (script: readonly ScriptedStep[]): Promise<AtlasHarness> =>
  openHarnessWith(scriptedModel({ script }))

const depsOf = (harness: AtlasHarness): TurnDeps => ({
  log: harness.log,
  model: harness.model,
  ids: harness.ids,
  assembly: defaultPipeline(),
})

const deltasOf = (signals: readonly ChannelSignal[], kind: 'text-delta' | 'reasoning-delta'): string =>
  signals
    .flatMap((signal) => (signal.type === 'chunk' && signal.chunk.type === kind ? [signal.chunk.text] : []))
    .join('')

const errorsOf = (signals: readonly ChannelSignal[]): string[] =>
  signals.flatMap((signal) =>
    signal.type === 'chunk' && signal.chunk.type === 'error' ? [signal.chunk.message] : [],
  )

const textOf = (event: EventOfType<'assistant-said'>): string =>
  event.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')

describe('running a turn', () => {
  it('publishes the step in flight and hands over to the durable event that supersedes it', async () => {
    const harness = await openHarness([
      { reasoning: { text: 'two files touched' }, text: 'auth and the router' },
    ])
    const branch = await harness.branches.create({})
    const channel = createDeltaChannel()
    const { seen, listener } = recorder()
    channel.subscribe({ branchId: branch.id, listener })
    const runner = new PublishingTurnRunner({ channel, deps: depsOf(harness) })

    const outcome = await runner.say({ branchId: branch.id, text: 'what changed?' })

    expect(outcome.status).toBe(ETurnStatus.Completed)
    expect(seen.find((signal) => signal.type !== 'events-appended')?.type).toBe('step-started')
    expect(deltasOf(seen, 'reasoning-delta')).toBe('two files touched')
    expect(deltasOf(seen, 'text-delta')).toBe('auth and the router')

    const durable = assistantEvent(await harness.log.read({ branchId: branch.id }))
    const ended = stepEnded(seen)
    expect(ended.supersededBy).toEqual({ eventId: durable.id, seq: durable.seq })
    expect(ended.end).toBe(EStepEnd.Completed)
    expect(deltasOf(seen, 'text-delta')).toBe(textOf(durable))
  })

  it('has already committed the durable event by the time the step-complete signal arrives', async () => {
    const harness = await openHarness([{ text: 'auth and the router' }])
    const branch = await harness.branches.create({})
    const channel = createDeltaChannel()
    let readAtHandover: Promise<Event[]> | undefined
    channel.subscribe({
      branchId: branch.id,
      listener: (signal) => {
        if (signal.type !== 'step-ended') return
        readAtHandover = harness.log.read({ branchId: branch.id })
      },
    })
    const runner = new PublishingTurnRunner({ channel, deps: depsOf(harness) })

    await runner.say({ branchId: branch.id, text: 'what changed?' })

    const events = await readAtHandover
    expect((events ?? []).map((event) => event.type)).toEqual(['user-said', 'assistant-said'])
  })

  it('leaves the channel empty between turns and gives the next step its own identity', async () => {
    const harness = await openHarness([{ text: 'auth and the router' }, { text: 'and the tests' }])
    const branch = await harness.branches.create({})
    const channel = createDeltaChannel()
    const { seen, listener } = recorder()
    channel.subscribe({ branchId: branch.id, listener })
    const runner = new PublishingTurnRunner({ channel, deps: depsOf(harness) })

    await runner.say({ branchId: branch.id, text: 'what changed?' })
    const between = channel.snapshot({ branchId: branch.id })
    await runner.say({ branchId: branch.id, text: 'anything else?' })

    expect(between).toEqual([])
    expect(channel.snapshot({ branchId: branch.id })).toEqual([])
    const started = seen.filter((signal) => signal.type === 'step-started')
    expect(started).toHaveLength(2)
    expect(started[0]?.stepId).not.toBe(started[1]?.stepId)
  })

  it('ends the step in flight when the model fails after it has already streamed', async () => {
    const harness = await openHarness([{ text: 'auth and the ', error: 'overloaded_error' }])
    const branch = await harness.branches.create({})
    const channel = createDeltaChannel()
    const { seen, listener } = recorder()
    channel.subscribe({ branchId: branch.id, listener })
    const runner = new PublishingTurnRunner({ channel, deps: depsOf(harness) })

    const outcome = await runner.say({ branchId: branch.id, text: 'what changed?' })

    expect(outcome.status).toBe(ETurnStatus.Failed)
    expect(seen.at(-1)).toEqual({
      type: 'step-ended',
      stepId: firstStepId(seen),
      end: EStepEnd.Failed,
      supersededBy: null,
    })
    expect(channel.snapshot({ branchId: branch.id })).toEqual([])
  })

  it('ends the step and names the reason when the model fails before it streamed anything', async () => {
    const harness = await openHarness([{ error: 'overloaded_error' }])
    const branch = await harness.branches.create({})
    const channel = createDeltaChannel()
    const { seen, listener } = recorder()
    channel.subscribe({ branchId: branch.id, listener })
    const runner = new PublishingTurnRunner({ channel, deps: depsOf(harness) })

    const outcome = await runner.say({ branchId: branch.id, text: 'what changed?' })

    expect(outcome.status).toBe(ETurnStatus.Failed)
    expect(errorsOf(seen)).toEqual(['overloaded_error'])
    expect(seen.at(-1)).toEqual({
      type: 'step-ended',
      stepId: firstStepId(seen),
      end: EStepEnd.Failed,
      supersededBy: null,
    })
    expect(channel.snapshot({ branchId: branch.id })).toEqual([])
  })

  it('closes a step that completed with nothing to commit as completed, not interrupted', async () => {
    const harness = await openHarness([{}])
    const branch = await harness.branches.create({})
    const channel = createDeltaChannel()
    const { seen, listener } = recorder()
    channel.subscribe({ branchId: branch.id, listener })
    const runner = new PublishingTurnRunner({ channel, deps: depsOf(harness) })

    const outcome = await runner.say({ branchId: branch.id, text: 'what changed?' })

    expect(outcome.status).toBe(ETurnStatus.Completed)
    expect(stepEnded(seen).end).toBe(EStepEnd.Completed)
  })

  it('publishes only to the branch it was asked to run', async () => {
    const harness = await openHarness([{ text: 'auth and the router' }])
    const branch = await harness.branches.create({})
    const other = await harness.branches.create({})
    const channel = createDeltaChannel()
    const { seen, listener } = recorder()
    channel.subscribe({ branchId: other.id, listener })
    const runner = new PublishingTurnRunner({ channel, deps: depsOf(harness) })

    await runner.say({ branchId: branch.id, text: 'what changed?' })

    expect(seen).toEqual([])
  })

  it('hands over to the interrupted durable event when the operator stops the reply', async () => {
    const harness = await openHarnessWith(interruptibleModel({ head: 'auth and the ', tail: 'router' }))
    const branch = await harness.branches.create({})
    const channel = createDeltaChannel()
    const { seen, listener } = recorder()
    channel.subscribe({ branchId: branch.id, listener })
    const controller = new AbortController()
    let armed = true
    const runner = new PublishingTurnRunner({
      channel,
      deps: {
        ...depsOf(harness),
        onChunk: (chunk) => {
          if (armed && chunk.type === 'text-delta') {
            armed = false
            controller.abort()
          }
          return chunk
        },
      },
    })

    const outcome = await runner.say({ branchId: branch.id, text: 'what changed?', signal: controller.signal })

    expect(outcome.status).toBe(ETurnStatus.Interrupted)
    const durable = assistantEvent(await harness.log.read({ branchId: branch.id }))
    expect(durable.interrupted).toBe(true)
    const ended = stepEnded(seen)
    expect(ended.end).toBe(EStepEnd.Interrupted)
    expect(ended.supersededBy).toEqual({ eventId: durable.id, seq: durable.seq })
    expect(deltasOf(seen, 'text-delta')).toBe(textOf(durable))
    expect(channel.snapshot({ branchId: branch.id })).toEqual([])
  })
})
