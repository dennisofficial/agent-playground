import { existsSync } from 'node:fs'

import {
  AfterToolHook,
  BeforeToolHook,
  EBeforeToolDecision,
  EStage,
  EWorktreeExit,
  exitedWorktreeOf,
  idleStopDue,
  staleSandboxes,
  type AfterTool,
  type BeforeTool,
  type HookOrder,
} from '@dltech/atlas-core'

import type { DockerEngine } from './engine'
import { DEFAULT_LABEL_PREFIX, worktreeLabel } from './sandbox'

export type LifecycleEngine = Pick<
  DockerEngine,
  'listContainers' | 'stopContainer' | 'removeContainer'
>

const findByWorktree = async (args: {
  engine: LifecycleEngine
  prefix: string
  worktree: string
}) => {
  const matches = await args.engine.listContainers({
    labels: { [worktreeLabel(args.prefix)]: args.worktree },
    all: true,
  })
  return matches[0]
}

export async function stopSandbox(args: {
  engine: LifecycleEngine
  worktree: string
  prefix?: string | undefined
}): Promise<boolean> {
  const prefix = args.prefix ?? DEFAULT_LABEL_PREFIX
  const found = await findByWorktree({ engine: args.engine, prefix, worktree: args.worktree })
  if (found === undefined || found.state !== 'running') return false

  await args.engine.stopContainer({ id: found.id })
  return true
}

export async function removeSandbox(args: {
  engine: LifecycleEngine
  worktree: string
  prefix?: string | undefined
}): Promise<boolean> {
  const prefix = args.prefix ?? DEFAULT_LABEL_PREFIX
  const found = await findByWorktree({ engine: args.engine, prefix, worktree: args.worktree })
  if (found === undefined) return false

  await args.engine.removeContainer({ id: found.id })
  return true
}

export async function sweepSandboxes(args: {
  engine: LifecycleEngine
  worktrees: readonly string[]
  prefix?: string | undefined
  exists?: ((path: string) => boolean) | undefined
}): Promise<readonly string[]> {
  const prefix = args.prefix ?? DEFAULT_LABEL_PREFIX
  const exists = args.exists ?? existsSync
  const labelled = await args.engine.listContainers({
    labels: { [worktreeLabel(prefix)]: undefined },
    all: true,
  })

  const stale = staleSandboxes({
    sandboxes: labelled.map((one) => ({ id: one.id, worktree: one.labels[worktreeLabel(prefix)] })),
    worktrees: args.worktrees,
    exists,
  })

  const removed: string[] = []
  for (const one of stale) {
    await args.engine.removeContainer({ id: one.id })
    if (one.worktree !== undefined) removed.push(one.worktree)
  }
  return removed
}

export type IdleStop = {
  noteBash: () => void
  halt: () => void
}

const IDLE_TICK_MS = 60_000

export function startIdleStop(args: {
  engine: LifecycleEngine
  worktree: string
  runningShells: () => number
  idleMinutes: () => number
  prefix?: string | undefined
  now?: (() => number) | undefined
  tickMs?: number | undefined
  onStopped?: (() => void) | undefined
}): IdleStop {
  const now = args.now ?? Date.now
  let lastBashAt = now()
  let stopping = false

  const tick = async (): Promise<void> => {
    const due = idleStopDue({
      lastBashAt,
      runningShells: args.runningShells(),
      idleMinutes: args.idleMinutes(),
      now: now(),
    })
    if (!due || stopping) return

    stopping = true
    try {
      const stopped = await stopSandbox({
        engine: args.engine,
        worktree: args.worktree,
        prefix: args.prefix,
      })
      if (stopped) args.onStopped?.()
    } catch {
      return
    } finally {
      stopping = false
    }
  }

  const timer = setInterval(() => void tick(), args.tickMs ?? IDLE_TICK_MS)
  timer.unref()

  return {
    noteBash: () => {
      lastBashAt = now()
    },
    halt: () => clearInterval(timer),
  }
}

const BASH_TOOL = 'bash'

export class BashActivityHook extends BeforeToolHook {
  readonly name = 'bash-activity'
  readonly order: HookOrder = { stage: EStage.Observe, nudge: 0 }

  private readonly onBash: () => void

  constructor(args: { onBash: () => void }) {
    super()
    this.onBash = args.onBash
  }

  readonly run: BeforeTool = async ({ call }) => {
    if (call.name === BASH_TOOL) this.onBash()
    return { decision: EBeforeToolDecision.Allow, input: call.input }
  }
}

export class ReclaimWorktreeSandboxHook extends AfterToolHook {
  readonly name = 'reclaim-worktree-sandbox'
  readonly order: HookOrder = { stage: EStage.Observe, nudge: 0 }

  private readonly engine: LifecycleEngine
  private readonly prefix: string | undefined

  constructor(args: { engine: LifecycleEngine; prefix?: string | undefined }) {
    super()
    this.engine = args.engine
    this.prefix = args.prefix
  }

  readonly run: AfterTool = async ({ result }) => {
    if (!result.ok) return {}

    const exited = exitedWorktreeOf(result.output)
    if (exited === undefined || exited.action !== EWorktreeExit.Remove) return {}

    await removeSandbox({ engine: this.engine, worktree: exited.path, prefix: this.prefix })
    return {}
  }
}
