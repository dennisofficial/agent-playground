import type { Event } from '../events/envelope'

export type ActiveWorktree = {
  path: string
  branch: string
  base: string
}

export function activeWorktreeOf(events: readonly Event[]): ActiveWorktree | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'worktree-exited') return undefined
    if (event?.type === 'worktree-entered') {
      return { path: event.path, branch: event.branch, base: event.base }
    }
  }

  return undefined
}

export function projectDirectoryOf(args: {
  events: readonly Event[]
  launchDirectory: string
}): string {
  return activeWorktreeOf(args.events)?.path ?? args.launchDirectory
}
