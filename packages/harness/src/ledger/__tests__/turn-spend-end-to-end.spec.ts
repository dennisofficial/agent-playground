import { afterEach, describe, expect, it } from 'bun:test'

import { ETurnStatus } from '../../loop/turn-outcome'
import { EDispatchMode, openExitPathHarness, type ExitPathHarness } from './exit-path-harness'

const opened: ExitPathHarness[] = []

afterEach(async () => {
  for (const entry of opened.splice(0)) await entry.close()
})

const open = async (args: Parameters<typeof openExitPathHarness>[0]): Promise<ExitPathHarness> => {
  const harness = await openExitPathHarness({ ...args, persist: true })
  opened.push(harness)
  return harness
}

const usage = (inputTokens: number) => ({
  inputTokens,
  outputTokens: 40,
  cacheReadTokens: inputTokens - 100,
  cacheWriteTokens: 100,
})

describe('a turn driven through the loop and read back out of SQLite', () => {
  it('persists what the steps were billed, tier by tier', async () => {
    const harness = await open({
      script: [
        { text: 'looking', callName: 'touch', usage: usage(1_000) },
        { text: 'still looking', callName: 'touch', usage: usage(1_600) },
        { text: 'two files changed', usage: usage(2_100) },
      ],
      dispatchMode: EDispatchMode.Auto,
    })

    const outcome = await harness.runner.say({ branchId: harness.branchId, text: 'what changed?' })

    expect(outcome.status).toBe(ETurnStatus.Completed)
    expect(await harness.recorded()).toMatchObject([
      {
        runId: outcome.runId,
        branchId: harness.branchId,
        status: ETurnStatus.Completed,
        providerId: 'anthropic',
        modelId: 'claude-opus-5',
        steps: 3,
        inputTokens: 4_700,
        outputTokens: 120,
        cacheReadTokens: 4_400,
        cacheWriteTokens: 300,
      },
    ])
  })

  it('gives the row a real duration and a pair of timestamps SQLite kept in order', async () => {
    const harness = await open({ script: [{ text: 'done', usage: usage(1_000) }] })

    await harness.runner.say({ branchId: harness.branchId, text: 'go' })

    const row = (await harness.recorded())[0]
    expect(row).toBeDefined()
    expect(Number.isNaN(Date.parse(row?.startedAt ?? ''))).toBe(false)
    expect(Date.parse(row?.endedAt ?? '')).toBeGreaterThanOrEqual(Date.parse(row?.startedAt ?? ''))
    expect(row?.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('keeps one row per turn across several turns on one branch', async () => {
    const harness = await open({
      script: [{ text: 'first', usage: usage(200) }, { text: 'second', usage: usage(400) }],
    })

    const first = await harness.runner.say({ branchId: harness.branchId, text: 'one' })
    const second = await harness.runner.say({ branchId: harness.branchId, text: 'two' })

    const rows = await harness.recorded()
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((row) => row.runId))).toEqual(new Set([first.runId, second.runId]))
    expect(rows.map((row) => row.inputTokens).sort((left, right) => left - right)).toEqual([200, 400])
  })

  it('persists a crash under its own status rather than as a returned failure', async () => {
    const harness = await open({
      script: [
        { text: 'looking', callName: 'touch', usage: usage(1_000) },
        { crashes: 'the loop threw' },
      ],
      dispatchMode: EDispatchMode.Auto,
    })

    await expect(
      harness.runner.say({ branchId: harness.branchId, text: 'what changed?' }),
    ).rejects.toThrow('the loop threw')

    const rows = await harness.recorded()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe('crashed')
    expect(rows[0]?.status).not.toBe(ETurnStatus.Failed)
    expect(rows[0]?.inputTokens).toBe(1_000)
  })

  it('writes nothing at all for a turn that never reached the model', async () => {
    const harness = await open({ script: [] })

    const outcome = await harness.runner.runTurn({ branchId: harness.branchId })

    expect(outcome.status).toBe(ETurnStatus.Idle)
    expect(await harness.recorded()).toEqual([])
  })
})
