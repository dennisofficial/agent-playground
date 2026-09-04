import { describe, expect, it } from 'bun:test'

import {
  EBeforeToolDecision,
  EToolEffect,
  EWorktreeExit,
  toCallId,
  toThreadId,
  type ToolCall,
} from '@dltech/atlas-core'

import { worktreeLabel } from '../sandbox'
import {
  BashActivityHook,
  ReclaimWorktreeSandboxHook,
  removeSandbox,
  startIdleStop,
  stopSandbox,
  sweepSandboxes,
  type LifecycleEngine,
} from '../lifecycle'

type Recorded = {
  stopped: string[]
  removed: string[]
}

const fakeEngine = (args: {
  containers?: { id: string; state: string; worktree?: string | undefined }[]
}): { engine: LifecycleEngine; recorded: Recorded } => {
  const recorded: Recorded = { stopped: [], removed: [] }

  const engine: LifecycleEngine = {
    listContainers: async () =>
      (args.containers ?? []).map((one) => ({
        id: one.id,
        name: one.id,
        state: one.state,
        labels:
          one.worktree === undefined ? {} : { [worktreeLabel('atlas-test')]: one.worktree },
      })),
    stopContainer: async ({ id }) => {
      recorded.stopped.push(id)
    },
    removeContainer: async ({ id }) => {
      recorded.removed.push(id)
    },
  }

  return { engine, recorded }
}

describe('stopSandbox', () => {
  it('stops the running container labelled for the worktree', async () => {
    const { engine, recorded } = fakeEngine({
      containers: [{ id: 'one', state: 'running', worktree: '/repo/wt' }],
    })

    expect(await stopSandbox({ engine, prefix: 'atlas-test', worktree: '/repo/wt' })).toBe(true)
    expect(recorded.stopped).toEqual(['one'])
  })

  it('leaves an already-stopped container alone', async () => {
    const { engine, recorded } = fakeEngine({
      containers: [{ id: 'one', state: 'exited', worktree: '/repo/wt' }],
    })

    expect(await stopSandbox({ engine, prefix: 'atlas-test', worktree: '/repo/wt' })).toBe(false)
    expect(recorded.stopped).toEqual([])
  })

  it('does nothing when no container carries the worktree', async () => {
    const { engine, recorded } = fakeEngine({ containers: [] })

    expect(await stopSandbox({ engine, prefix: 'atlas-test', worktree: '/repo/wt' })).toBe(false)
    expect(recorded.stopped).toEqual([])
  })
})

describe('removeSandbox', () => {
  it('removes the container labelled for the worktree, running or not', async () => {
    const { engine, recorded } = fakeEngine({
      containers: [{ id: 'one', state: 'running', worktree: '/repo/wt' }],
    })

    expect(await removeSandbox({ engine, prefix: 'atlas-test', worktree: '/repo/wt' })).toBe(true)
    expect(recorded.removed).toEqual(['one'])
  })

  it('does nothing when no container carries the worktree', async () => {
    const { engine, recorded } = fakeEngine({ containers: [] })

    expect(await removeSandbox({ engine, prefix: 'atlas-test', worktree: '/repo/wt' })).toBe(false)
    expect(recorded.removed).toEqual([])
  })
})

describe('sweepSandboxes', () => {
  it('removes containers whose worktree is gone and keeps the rest', async () => {
    const { engine, recorded } = fakeEngine({
      containers: [
        { id: 'live', state: 'running', worktree: '/repo/.atlas/worktrees/live' },
        { id: 'orphan', state: 'exited', worktree: '/repo/.atlas/worktrees/merged' },
        { id: 'unlabelled', state: 'running' },
      ],
    })

    const removed = await sweepSandboxes({
      engine,
      prefix: 'atlas-test',
      worktrees: ['/repo', '/repo/.atlas/worktrees/live'],
      exists: () => false,
    })

    expect(recorded.removed).toEqual(['orphan'])
    expect(removed).toEqual(['/repo/.atlas/worktrees/merged'])
  })

  it('keeps a container whose worktree another repository still holds on disk', async () => {
    const { engine, recorded } = fakeEngine({
      containers: [{ id: 'foreign', state: 'running', worktree: '/other-repo/checkout' }],
    })

    const removed = await sweepSandboxes({
      engine,
      prefix: 'atlas-test',
      worktrees: ['/repo'],
      exists: () => true,
    })

    expect(recorded.removed).toEqual([])
    expect(removed).toEqual([])
  })
})

describe('the idle stopwatch', () => {
  const until = async (holds: () => boolean, attempts = 200): Promise<boolean> => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (holds()) return true
      await Bun.sleep(5)
    }
    return holds()
  }

  it('does not fire while a background shell is running, and fires once it ends', async () => {
    const { engine, recorded } = fakeEngine({
      containers: [{ id: 'one', state: 'running', worktree: '/repo/wt' }],
    })
    let runningShells = 1
    let now = 1_000_000

    const idle = startIdleStop({
      engine,
      prefix: 'atlas-test',
      worktree: '/repo/wt',
      runningShells: () => runningShells,
      idleMinutes: () => 1,
      now: () => now,
      tickMs: 5,
    })

    try {
      now += 5 * 60_000
      expect(await until(() => recorded.stopped.length > 0, 40)).toBe(false)

      runningShells = 0
      expect(await until(() => recorded.stopped.length > 0)).toBe(true)
      expect(recorded.stopped).toEqual(['one'])
    } finally {
      idle.halt()
    }
  })

  it('starts the window over when a bash call lands', async () => {
    const { engine, recorded } = fakeEngine({
      containers: [{ id: 'one', state: 'running', worktree: '/repo/wt' }],
    })
    let now = 1_000_000

    const idle = startIdleStop({
      engine,
      prefix: 'atlas-test',
      worktree: '/repo/wt',
      runningShells: () => 0,
      idleMinutes: () => 1,
      now: () => now,
      tickMs: 5,
    })

    try {
      now += 50_000
      idle.noteBash()
      await Bun.sleep(30)
      expect(recorded.stopped).toEqual([])

      now += 60_000
      expect(await until(() => recorded.stopped.length > 0)).toBe(true)
    } finally {
      idle.halt()
    }
  })

  it('reports when it stops the sandbox, and stays quiet while nothing is due', async () => {
    let state = 'running'
    const { engine, recorded } = fakeEngine({
      containers: [{ id: 'one', state: 'running', worktree: '/repo/wt' }],
    })
    const stopping: LifecycleEngine = {
      ...engine,
      listContainers: async () => [
        { id: 'one', name: 'one', state, labels: { [worktreeLabel('atlas-test')]: '/repo/wt' } },
      ],
      stopContainer: async ({ id }) => {
        recorded.stopped.push(id)
        state = 'exited'
      },
    }
    let now = 1_000_000
    let announced = 0

    const idle = startIdleStop({
      engine: stopping,
      prefix: 'atlas-test',
      worktree: '/repo/wt',
      runningShells: () => 0,
      idleMinutes: () => 1,
      now: () => now,
      tickMs: 5,
      onStopped: () => {
        announced += 1
      },
    })

    try {
      expect(await until(() => announced > 0, 40)).toBe(false)

      now += 60_000
      expect(await until(() => announced > 0)).toBe(true)
      expect(recorded.stopped).toEqual(['one'])

      const settled = announced
      expect(await until(() => announced > settled, 40)).toBe(false)
    } finally {
      idle.halt()
    }
  })
})

const bashCall = (name: string): ToolCall => ({
  callId: toCallId('call-1'),
  name,
  input: { command: 'bun test' },
  effect: EToolEffect.Destructive,
  threadId: toThreadId('thread'),
})

describe('BashActivityHook', () => {
  it('notes a bash call and lets it through untouched', async () => {
    let noted = 0
    const hook = new BashActivityHook({ onBash: () => (noted += 1) })

    const outcome = await hook.run({
      call: bashCall('bash'),
      projectDirectory: '/repo',
      events: [],
      signal: new AbortController().signal,
    })

    expect(noted).toBe(1)
    expect(outcome.decision).toBe(EBeforeToolDecision.Allow)
    if (outcome.decision === EBeforeToolDecision.Allow) {
      expect(outcome.input).toEqual({ command: 'bun test' })
    }
  })

  it('ignores every other tool', async () => {
    let noted = 0
    const hook = new BashActivityHook({ onBash: () => (noted += 1) })

    await hook.run({
      call: bashCall('read'),
      projectDirectory: '/repo',
      events: [],
      signal: new AbortController().signal,
    })

    expect(noted).toBe(0)
  })
})

describe('ReclaimWorktreeSandboxHook', () => {
  const exited = (action: EWorktreeExit) => ({
    ok: true as const,
    output: { exitedWorktree: { path: '/repo/.atlas/worktrees/merged', action } },
    modelText: '',
  })

  it('removes the sandbox of a worktree the session just removed', async () => {
    const { engine, recorded } = fakeEngine({
      containers: [
        { id: 'gone', state: 'running', worktree: '/repo/.atlas/worktrees/merged' },
        { id: 'kept', state: 'running', worktree: '/repo/.atlas/worktrees/live' },
      ],
    })
    const hook = new ReclaimWorktreeSandboxHook({ engine, prefix: 'atlas-test' })

    await hook.run({
      call: bashCall('exit_worktree'),
      result: exited(EWorktreeExit.Remove),
      signal: new AbortController().signal,
    })

    expect(recorded.removed).toEqual(['gone'])
  })

  it('leaves the sandbox alone when the worktree is kept', async () => {
    const { engine, recorded } = fakeEngine({
      containers: [{ id: 'kept', state: 'running', worktree: '/repo/.atlas/worktrees/merged' }],
    })
    const hook = new ReclaimWorktreeSandboxHook({ engine, prefix: 'atlas-test' })

    await hook.run({
      call: bashCall('exit_worktree'),
      result: exited(EWorktreeExit.Keep),
      signal: new AbortController().signal,
    })

    expect(recorded.removed).toEqual([])
  })

  it('does nothing for a call that failed or moved no worktree', async () => {
    const { engine, recorded } = fakeEngine({
      containers: [{ id: 'kept', state: 'running', worktree: '/repo/.atlas/worktrees/merged' }],
    })
    const hook = new ReclaimWorktreeSandboxHook({ engine, prefix: 'atlas-test' })
    const signal = new AbortController().signal

    await hook.run({
      call: bashCall('exit_worktree'),
      result: { ok: false, reason: 'refused' },
      signal,
    })
    await hook.run({
      call: bashCall('bash'),
      result: { ok: true, output: { command: 'ls' }, modelText: '' },
      signal,
    })

    expect(recorded.removed).toEqual([])
  })
})
