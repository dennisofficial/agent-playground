import { describe, expect, it } from 'bun:test'

import { toBranchId, toRunId, type ClockPort, type ProviderIdentity } from '@dltech/atlas-core'

import { openTurnSpend, recordTurnSpend, TURN_CRASHED } from '../record-turn-spend'
import type { TurnLedgerPort, TurnSpend } from '../turn-ledger.port'

const MODEL: ProviderIdentity = { id: 'anthropic', modelId: 'claude-opus-5' }
const BRANCH = toBranchId('branch-1')
const RUN = toRunId('run-1')

const tickingClock = (stamps: readonly string[]): ClockPort => {
  let index = 0
  return { now: () => stamps[Math.min(index++, stamps.length - 1)] ?? '' }
}

const overTenSeconds = () => tickingClock(['2026-08-26T10:00:00.000Z', '2026-08-26T10:00:10.000Z'])

type RecordingLedger = TurnLedgerPort & { recorded: TurnSpend[] }

const recordingLedger = (): RecordingLedger => {
  const recorded: TurnSpend[] = []
  return {
    recorded,
    record: async (spend) => {
      recorded.push(spend)
    },
    forBranch: async () => recorded,
  }
}

const failingLedger = (): TurnLedgerPort => ({
  record: async () => {
    throw new Error('the ledger is unavailable')
  },
  forBranch: async () => [],
})

describe('a turn tallied across its steps', () => {
  it('sums the four token tiers over every step and counts the steps', async () => {
    const ledger = recordingLedger()
    const tally = openTurnSpend({ ledger, clock: overTenSeconds(), model: MODEL })

    tally.countStep({ inputTokens: 1_000, outputTokens: 40, cacheReadTokens: 900, cacheWriteTokens: 100 })
    tally.countStep({ inputTokens: 1_500, outputTokens: 60, cacheReadTokens: 1_400, cacheWriteTokens: 0 })
    tally.countStep({ inputTokens: 2_100, outputTokens: 20, cacheReadTokens: 2_000, cacheWriteTokens: 0 })
    await tally.settle({ branchId: BRANCH, runId: RUN, status: 'completed' })

    expect(ledger.recorded).toEqual([
      {
        runId: RUN,
        branchId: BRANCH,
        status: 'completed',
        providerId: 'anthropic',
        modelId: 'claude-opus-5',
        steps: 3,
        inputTokens: 4_600,
        outputTokens: 120,
        cacheReadTokens: 4_300,
        cacheWriteTokens: 100,
        startedAt: '2026-08-26T10:00:00.000Z',
        endedAt: '2026-08-26T10:00:10.000Z',
        durationMs: 10_000,
      },
    ])
  })

  it('counts a step whose usage the provider never reported, since it still happened', async () => {
    const ledger = recordingLedger()
    const tally = openTurnSpend({ ledger, clock: overTenSeconds(), model: MODEL })

    tally.countStep({ inputTokens: 800, outputTokens: 20 })
    tally.countStep(undefined)
    await tally.settle({ branchId: BRANCH, runId: RUN, status: 'interrupted' })

    expect(ledger.recorded[0]?.steps).toBe(2)
    expect(ledger.recorded[0]?.inputTokens).toBe(800)
    expect(ledger.recorded[0]?.cacheReadTokens).toBe(0)
  })

  it('records whatever terminal status it was handed, including one it has never seen', async () => {
    const ledger = recordingLedger()

    for (const status of ['completed', 'failed', 'interrupted', 'paused', 'a-status-invented-tomorrow']) {
      const tally = openTurnSpend({ ledger, clock: overTenSeconds(), model: MODEL })
      tally.countStep({ inputTokens: 10, outputTokens: 1 })
      await tally.settle({ branchId: BRANCH, runId: toRunId(`run-${status}`), status })
    }

    expect(ledger.recorded.map((spend) => spend.status)).toEqual([
      'completed',
      'failed',
      'interrupted',
      'paused',
      'a-status-invented-tomorrow',
    ])
  })

  it('writes nothing for a turn that never reached the model', async () => {
    const ledger = recordingLedger()
    const tally = openTurnSpend({ ledger, clock: overTenSeconds(), model: MODEL })

    await tally.settle({ branchId: BRANCH, runId: RUN, status: 'idle' })

    expect(ledger.recorded).toEqual([])
  })

  it('writes a crash that counted no steps, since a turn that threw is worth knowing about', async () => {
    const ledger = recordingLedger()
    const tally = openTurnSpend({ ledger, clock: overTenSeconds(), model: MODEL })

    await tally.settle({ branchId: BRANCH, runId: RUN, status: TURN_CRASHED })

    expect(ledger.recorded).toMatchObject([{ status: TURN_CRASHED, steps: 0, inputTokens: 0 }])
  })

  it('costs nothing when no ledger is bound', async () => {
    const tally = openTurnSpend({ clock: overTenSeconds(), model: MODEL })
    tally.countStep({ inputTokens: 10, outputTokens: 1 })

    await expect(
      tally.settle({ branchId: BRANCH, runId: RUN, status: 'completed' }),
    ).resolves.toBeUndefined()
  })

  it('reads the clock for itself when the caller has none', async () => {
    const ledger = recordingLedger()
    const tally = openTurnSpend({ ledger, model: MODEL })

    tally.countStep({ inputTokens: 10, outputTokens: 1 })
    await tally.settle({ branchId: BRANCH, runId: RUN, status: 'completed' })

    expect(Number.isNaN(Date.parse(ledger.recorded[0]?.startedAt ?? ''))).toBe(false)
    expect(ledger.recorded[0]?.durationMs).toBeGreaterThanOrEqual(0)
  })
})

describe('the ledger is accounting, not the turn', () => {
  it('reports a failed write rather than throwing it back at the caller', async () => {
    const seen: unknown[] = []
    const tally = openTurnSpend({
      ledger: failingLedger(),
      clock: overTenSeconds(),
      model: MODEL,
      onLedgerFailure: (error) => seen.push(error),
    })

    tally.countStep({ inputTokens: 10, outputTokens: 1 })

    await expect(
      tally.settle({ branchId: BRANCH, runId: RUN, status: 'completed' }),
    ).resolves.toBeUndefined()
    expect(seen).toHaveLength(1)
  })

  it('swallows a failed write even with nobody watching', async () => {
    const tally = openTurnSpend({ ledger: failingLedger(), clock: overTenSeconds(), model: MODEL })
    tally.countStep({ inputTokens: 10, outputTokens: 1 })

    await expect(
      tally.settle({ branchId: BRANCH, runId: RUN, status: 'completed' }),
    ).resolves.toBeUndefined()
  })
})

describe('the write on its own, for a caller that tallied elsewhere', () => {
  it('derives the duration from the two timestamps it was given', async () => {
    const ledger = recordingLedger()

    await recordTurnSpend({
      ledger,
      branchId: BRANCH,
      runId: RUN,
      status: 'completed',
      model: MODEL,
      steps: 2,
      usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 90, cacheWriteTokens: 0 },
      startedAt: '2026-08-26T10:00:00.000Z',
      endedAt: '2026-08-26T10:00:03.500Z',
    })

    expect(ledger.recorded[0]?.durationMs).toBe(3_500)
  })

  it('refuses a negative duration when the clock ran backwards', async () => {
    const ledger = recordingLedger()

    await recordTurnSpend({
      ledger,
      branchId: BRANCH,
      runId: RUN,
      status: 'completed',
      model: MODEL,
      steps: 1,
      usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
      startedAt: '2026-08-26T10:00:10.000Z',
      endedAt: '2026-08-26T10:00:00.000Z',
    })

    expect(ledger.recorded[0]?.durationMs).toBe(0)
  })
})
