export type LabelledSandbox = {
  id: string
  worktree: string | undefined
}

export function idleStopDue(args: {
  lastBashAt: number
  runningShells: number
  idleMinutes: number
  now: number
}): boolean {
  if (args.runningShells > 0) return false
  return args.now - args.lastBashAt >= args.idleMinutes * 60_000
}

export function staleSandboxes(args: {
  sandboxes: readonly LabelledSandbox[]
  worktrees: readonly string[]
  exists: (path: string) => boolean
}): readonly LabelledSandbox[] {
  const listed = new Set(args.worktrees)

  return args.sandboxes.filter((sandbox) => {
    if (sandbox.worktree === undefined) return false
    if (listed.has(sandbox.worktree)) return false
    return !args.exists(sandbox.worktree)
  })
}
