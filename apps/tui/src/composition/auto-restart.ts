import type { SourceStaleness } from './update-check'

export type RestartSafety = {
  readonly working: boolean
  readonly interrupting: boolean
  readonly compacting: boolean
  readonly approvalOpen: boolean
  readonly exitGuardOpen: boolean
  readonly queuedMessages: number
  readonly runningTasks: number
  readonly draftEmpty: boolean
}

export function autoRestartBlocker(args: RestartSafety): string | null {
  if (args.working) return 'a turn is running'
  if (args.interrupting) return 'the turn is being interrupted'
  if (args.compacting) return 'a compaction is running'
  if (args.approvalOpen) return 'an approval is waiting'
  if (args.exitGuardOpen) return 'the exit guard is open'
  if (args.runningTasks > 0) return 'tasks are still running'
  if (args.queuedMessages > 0) return 'a message is still queued'
  if (!args.draftEmpty) return 'the composer holds a draft'
  return null
}

export async function settleStaleness(args: {
  staleness: SourceStaleness | null
  autoRestart: boolean
  restart: (() => void) | null
  readSafety: () => RestartSafety
}): Promise<void> {
  const probe = args.staleness
  if (probe === null) return
  if (!(await probe.stale())) return

  const restart = args.restart
  const clean =
    args.autoRestart && restart !== null && autoRestartBlocker(args.readSafety()) === null
  if (clean) {
    restart()
    return
  }

  await probe.check()
}
