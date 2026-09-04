import { describe, expect, it } from 'bun:test'

import { autoRestartBlocker, settleStaleness, type RestartSafety } from '../auto-restart'
import type { SourceStaleness } from '../update-check'

const CLEAN: RestartSafety = {
  working: false,
  interrupting: false,
  compacting: false,
  approvalOpen: false,
  exitGuardOpen: false,
  queuedMessages: 0,
  runningTasks: 0,
  draftEmpty: true,
}

describe('autoRestartBlocker', () => {
  it('clears a settled session with nothing in flight', () => {
    expect(autoRestartBlocker(CLEAN)).toBeNull()
  })

  it('blocks on anything a restart would lose or interrupt', () => {
    const cases: readonly [Partial<RestartSafety>, string][] = [
      [{ working: true }, 'turn is running'],
      [{ interrupting: true }, 'interrupt'],
      [{ compacting: true }, 'compaction'],
      [{ approvalOpen: true }, 'approval'],
      [{ exitGuardOpen: true }, 'exit guard'],
      [{ runningTasks: 2 }, 'tasks'],
      [{ queuedMessages: 1 }, 'queued'],
      [{ draftEmpty: false }, 'draft'],
    ]

    for (const [patch, expected] of cases) {
      expect(autoRestartBlocker({ ...CLEAN, ...patch })).toContain(expected)
    }
  })
})

describe('settleStaleness', () => {
  const rig = (args: { stale: boolean }) => {
    const calls = { stale: 0, check: 0, restart: 0, readSafety: 0 }
    const probe: SourceStaleness = {
      stale: async () => {
        calls.stale += 1
        return args.stale
      },
      check: async () => {
        calls.check += 1
      },
    }
    return {
      calls,
      probe,
      restart: () => {
        calls.restart += 1
      },
      readSafety: () => {
        calls.readSafety += 1
        return CLEAN
      },
    }
  }

  it('does nothing without a probe, as a non-source build has no stamp to move', async () => {
    const { calls, readSafety, restart } = rig({ stale: true })

    await settleStaleness({ staleness: null, autoRestart: true, restart, readSafety })

    expect(calls).toEqual({ stale: 0, check: 0, restart: 0, readSafety: 0 })
  })

  it('does nothing while the tree still matches the launch stamp', async () => {
    const { calls, probe, readSafety, restart } = rig({ stale: false })

    await settleStaleness({ staleness: probe, autoRestart: true, restart, readSafety })

    expect(calls.restart).toBe(0)
    expect(calls.check).toBe(0)
    expect(calls.readSafety).toBe(0)
  })

  it('restarts a clean session the moment the tree has moved', async () => {
    const { calls, probe, readSafety, restart } = rig({ stale: true })

    await settleStaleness({ staleness: probe, autoRestart: true, restart, readSafety })

    expect(calls.restart).toBe(1)
    expect(calls.check).toBe(0)
  })

  it('falls back to the notice when the toggle is off', async () => {
    const { calls, probe, readSafety, restart } = rig({ stale: true })

    await settleStaleness({ staleness: probe, autoRestart: false, restart, readSafety })

    expect(calls.restart).toBe(0)
    expect(calls.check).toBe(1)
  })

  it('falls back to the notice when no restart path was wired', async () => {
    const { calls, probe, readSafety } = rig({ stale: true })

    await settleStaleness({ staleness: probe, autoRestart: true, restart: null, readSafety })

    expect(calls.check).toBe(1)
  })

  it('falls back to the notice when anything is in flight', async () => {
    const { calls, probe, restart } = rig({ stale: true })

    await settleStaleness({
      staleness: probe,
      autoRestart: true,
      restart,
      readSafety: () => ({ ...CLEAN, runningTasks: 1 }),
    })

    expect(calls.restart).toBe(0)
    expect(calls.check).toBe(1)
  })

  it('holds the restart while a turn is still running', async () => {
    const { calls, probe, restart } = rig({ stale: true })

    await settleStaleness({
      staleness: probe,
      autoRestart: true,
      restart,
      readSafety: () => ({ ...CLEAN, working: true }),
    })

    expect(calls.restart).toBe(0)
    expect(calls.check).toBe(1)
  })
})
