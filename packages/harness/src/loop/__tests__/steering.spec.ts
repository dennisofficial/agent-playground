import { describe, expect, it } from 'bun:test'

import { EStage, type AfterTurn } from '@dltech/atlas-core'

import { ETurnStatus } from '..'
import { createHookRegistry } from '../../hooks/registry'
import { openSteerable, userTexts } from './steerable-turn'

const typesOf = (events: readonly { type: string }[]): string[] => events.map((event) => event.type)

describe('a message typed while the last model step is running', () => {
  it('is answered by the same turn rather than left behind a Completed', async () => {
    const { runner, model, branchId } = await openSteerable({
      script: [{ text: 'starting on X' }, { text: 'switching to Y' }],
      types: { text: 'actually, do Y', onStep: 1 },
    })

    const outcome = await runner.say({ branchId, text: 'do X' })

    expect(outcome.status).toBe(ETurnStatus.Completed)
    expect(model.doStreamCalls).toHaveLength(2)
    expect(userTexts(model.doStreamCalls[1]?.prompt ?? [])).toContain('actually, do Y')
  })

  it('lands after the assistant turn it followed, so the exchange never ends on the assistant', async () => {
    const { runner, harness, branchId } = await openSteerable({
      script: [{ text: 'starting on X' }, { text: 'switching to Y' }],
      types: { text: 'actually, do Y', onStep: 1 },
    })

    await runner.say({ branchId, text: 'do X' })

    const events = await harness.log.read({ branchId })
    expect(typesOf(events)).toEqual(['user-said', 'assistant-said', 'user-said', 'assistant-said'])
  })

  it('is pulled from the queue once, however often the loop asks', async () => {
    const { runner, harness, branchId, queue } = await openSteerable({
      script: [{ text: 'starting on X' }, { text: 'switching to Y' }],
      types: { text: 'actually, do Y', onStep: 1 },
    })

    await runner.say({ branchId, text: 'do X' })

    expect(queue.drains()).toBeGreaterThan(1)
    const events = await harness.log.read({ branchId })
    expect(events.filter((event) => event.type === 'user-said' && event.text === 'actually, do Y')).toHaveLength(1)
  })

  it('costs a model step, so a turn out of budget reports Exhausted rather than looping', async () => {
    const { runner, model, branchId } = await openSteerable({
      script: [{ text: 'starting on X' }, { text: 'never asked' }],
      types: { text: 'actually, do Y', onStep: 1 },
      maxSteps: 1,
    })

    const outcome = await runner.say({ branchId, text: 'do X' })

    expect(outcome.status).toBe(ETurnStatus.Exhausted)
    expect(model.doStreamCalls).toHaveLength(1)
  })

  it('spends the whole step budget when it keeps arriving, and the spin guard never gets there first', async () => {
    const { runner, model, branchId } = await openSteerable({
      script: [{ text: 'one' }, { text: 'two' }, { text: 'three' }, { text: 'never asked' }],
      types: { text: 'no, the other thing', onStep: 'each' },
      maxSteps: 3,
    })

    const outcome = await runner.say({ branchId, text: 'do X' })

    expect(outcome.status).toBe(ETurnStatus.Exhausted)
    expect(model.doStreamCalls).toHaveLength(3)
  })
})

describe('a message typed while a tool call is settling', () => {
  it('lands after the result rather than splitting the call from it', async () => {
    const { runner, harness, branchId } = await openSteerable({
      script: [{ text: 'touching', calls: [{ callId: 'call-1', name: 'touch', input: {} }] }, { text: 'touched it' }],
      types: { text: 'actually, do Y', onStep: 1 },
      withTools: true,
    })

    const outcome = await runner.say({ branchId, text: 'do X' })

    expect(outcome.status).toBe(ETurnStatus.Completed)
    const events = await harness.log.read({ branchId })
    expect(typesOf(events)).toEqual([
      'user-said',
      'assistant-said',
      'tool-called',
      'tool-result',
      'user-said',
      'assistant-said',
    ])
  })
})

describe('a turn nobody steers', () => {
  it('completes after exactly the steps its script holds when no queue is wired at all', async () => {
    const { runner, harness, model, branchId } = await openSteerable({
      script: [{ text: 'auth and the router' }],
      withQueue: false,
    })

    const outcome = await runner.say({ branchId, text: 'what changed?' })

    expect(outcome.status).toBe(ETurnStatus.Completed)
    expect(model.doStreamCalls).toHaveLength(1)
    const events = await harness.log.read({ branchId })
    expect(typesOf(events)).toEqual(['user-said', 'assistant-said'])
  })

  it('asks an empty queue and appends nothing for the nothing it gets back', async () => {
    const { runner, harness, model, branchId, queue } = await openSteerable({
      script: [{ text: 'auth and the router' }],
    })

    const outcome = await runner.say({ branchId, text: 'what changed?' })

    expect(outcome.status).toBe(ETurnStatus.Completed)
    expect(model.doStreamCalls).toHaveLength(1)
    expect(queue.drains()).toBeGreaterThan(0)
    const events = await harness.log.read({ branchId })
    expect(typesOf(events)).toEqual(['user-said', 'assistant-said'])
  })
})

const nudging = (text: string): AfterTurn => async () => [{ type: 'nudge', text, lifetimeSteps: 1 }]

describe('AfterTurn against a steered turn', () => {
  it('runs once at the end of the turn, not once per continuation', async () => {
    const hooks = createHookRegistry({
      afterTurn: [{ name: 'observed', order: { stage: EStage.Observe, nudge: 0 }, run: nudging('observed') }],
    })
    const { runner, harness, branchId } = await openSteerable({
      script: [{ text: 'starting on X' }, { text: 'switching to Y' }],
      types: { text: 'actually, do Y', onStep: 1 },
      hooks,
    })

    await runner.say({ branchId, text: 'do X' })

    const events = await harness.log.read({ branchId })
    expect(events.filter((event) => event.type === 'nudge')).toHaveLength(1)
    expect(events.at(-1)?.type).toBe('nudge')
  })
})

describe('a message written straight to the log behind the loop', () => {
  it('is noticed and refused rather than sent as a prefill, naming the turn it would have prefilled', async () => {
    const { runner, harness, model, branchId } = await openSteerable({
      script: [{ text: 'starting on X' }, { text: 'never asked' }],
      appends: { text: 'actually, do Y', onStep: 1 },
    })

    const outcome = await runner.say({ branchId, text: 'do X' })

    expect(outcome.status).toBe(ETurnStatus.Failed)
    expect(model.doStreamCalls).toHaveLength(1)
    const events = await harness.log.read({ branchId })
    const spoken = events.find((event) => event.type === 'assistant-said')
    const message = outcome.status === ETurnStatus.Failed ? outcome.message : ''
    expect(message).toContain(spoken?.id ?? 'no event')
    expect(message).toMatch(/prefill/)
  })
})
