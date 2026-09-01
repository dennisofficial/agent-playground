import type { EventDraft } from '../events/body'
import type { Event } from '../events/envelope'

export type ActiveWorktree = {
  path: string
  branch: string
  base: string | undefined
  adopted: boolean
}

const activeFrom = (body: {
  path: string
  branch: string
  base?: string | undefined
  adopted?: boolean | undefined
}): ActiveWorktree => ({
  path: body.path,
  branch: body.branch,
  base: body.base,
  adopted: body.adopted === true,
})

export function activeWorktreeOf(events: readonly Event[]): ActiveWorktree | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'worktree-exited') return undefined
    if (event?.type === 'worktree-entered') return activeFrom(event)
  }

  return undefined
}

export function activeWorktreeAfter(args: {
  drafts: readonly EventDraft[]
  active: ActiveWorktree | undefined
}): ActiveWorktree | undefined {
  for (let index = args.drafts.length - 1; index >= 0; index -= 1) {
    const draft = args.drafts[index]
    if (draft?.type === 'worktree-exited') return undefined
    if (draft?.type === 'worktree-entered') return activeFrom(draft)
  }

  return args.active
}

export function projectDirectoryOf(args: {
  events: readonly Event[]
  launchDirectory: string
}): string {
  return activeWorktreeOf(args.events)?.path ?? args.launchDirectory
}
