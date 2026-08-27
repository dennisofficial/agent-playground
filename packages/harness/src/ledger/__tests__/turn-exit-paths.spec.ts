import { afterEach, describe, expect, it } from 'bun:test'

import { ETurnStatus } from '../../loop/turn-outcome'
import { EDispatchMode, openExitPathHarness, type ExitPathHarness } from './exit-path-harness'

const opened: ExitPathHarness[] = []

afterEach(async () => {
  for (const entry of opened.splice(0)) await entry.close()
})

const open = async (args: Parameters<typeof openExitPathHarness>[0]): Promise<ExitPathHarness> => {
  const harness = await openExitPathHarness(args)
  opened.push(harness)
  return harness
}

const usage = (inputTokens: number) => ({ inputTokens, outputTokens: 10, cacheReadTokens: 1 })

describe('the exits turn-ledger-wiring does not reach', () => {
  it('records an interrupted turn', async () => {
    const controller = new AbortController()
    const harness = await open({
      script: [{ text: 'thinking', usage: usage(2_000), interruptsWith: controller }],
    })

    const outcome = await harness.runner.say({
      threadId: harness.threadId,
      text: 'what changed?',
      signal: controller.signal,
    })

    expect(outcome.status).toBe(ETurnStatus.Interrupted)
    const rows = await harness.recorded()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe(outcome.status)
    expect(rows[0]?.steps).toBe(harness.stepsTaken())
  })

  it('records a turn paused awaiting approval', async () => {
    const harness = await open({
      script: [{ text: 'about to touch it', callName: 'touch', usage: usage(1_200) }],
      dispatchMode: EDispatchMode.Ask,
    })

    const outcome = await harness.runner.say({ threadId: harness.threadId, text: 'touch it' })

    expect(outcome.status).toBe(ETurnStatus.Paused)
    const rows = await harness.recorded()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe(outcome.status)
    expect(rows[0]?.steps).toBe(harness.stepsTaken())
  })

  it('records a turn paused with nothing able to settle its tool call', async () => {
    const harness = await open({
      script: [{ text: 'about to touch it', callName: 'touch', usage: usage(1_200) }],
      dispatchMode: EDispatchMode.None,
    })

    const outcome = await harness.runner.say({ threadId: harness.threadId, text: 'touch it' })

    expect(outcome.status).toBe(ETurnStatus.Paused)
    const rows = await harness.recorded()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe(outcome.status)
  })

  it('records a turn that failed on a later step, carrying the steps before it', async () => {
    const harness = await open({
      script: [
        { text: 'looking', callName: 'touch', usage: usage(1_000) },
        { fails: 'overloaded_error' },
      ],
      dispatchMode: EDispatchMode.Auto,
    })

    const outcome = await harness.runner.say({ threadId: harness.threadId, text: 'what changed?' })

    expect(outcome.status).toBe(ETurnStatus.Failed)
    const rows = await harness.recorded()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe(outcome.status)
    expect(rows[0]?.inputTokens).toBe(1_000)
  })

  it('records a turn whose only model step failed, which was still a request to the provider', async () => {
    const harness = await open({ script: [{ fails: 'overloaded_error' }] })

    const outcome = await harness.runner.say({ threadId: harness.threadId, text: 'what changed?' })

    expect(outcome.status).toBe(ETurnStatus.Failed)
    expect(harness.stepsTaken()).toBe(1)
    const rows = await harness.recorded()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe(ETurnStatus.Failed)
    expect(rows[0]?.steps).toBe(1)
  })

  it('keeps the tokens of the steps a turn completed before it crashed', async () => {
    const harness = await open({
      script: [
        { text: 'looking', callName: 'touch', usage: usage(1_000) },
        { text: 'still looking', callName: 'touch', usage: usage(1_500) },
        { crashes: 'the loop threw' },
      ],
      dispatchMode: EDispatchMode.Auto,
    })

    await expect(
      harness.runner.say({ threadId: harness.threadId, text: 'what changed?' }),
    ).rejects.toThrow('the loop threw')

    const rows = await harness.recorded()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe('crashed')
    expect(rows[0]?.steps).toBe(2)
    expect(rows[0]?.inputTokens).toBe(2_500)
    expect(rows[0]?.outputTokens).toBe(20)
  })

  it('sums the tokens of every step a multi-step turn took', async () => {
    const harness = await open({
      script: [
        { text: 'one', callName: 'touch', usage: usage(1_000) },
        { text: 'two', callName: 'touch', usage: usage(1_500) },
        { text: 'done', usage: usage(2_000) },
      ],
      dispatchMode: EDispatchMode.Auto,
    })

    const outcome = await harness.runner.say({ threadId: harness.threadId, text: 'touch things' })

    expect(outcome.status).toBe(ETurnStatus.Completed)
    expect(harness.stepsTaken()).toBe(3)
    const rows = await harness.recorded()
    expect(rows[0]?.steps).toBe(3)
    expect(rows[0]?.inputTokens).toBe(4_500)
    expect(rows[0]?.cacheReadTokens).toBe(3)
  })
})
