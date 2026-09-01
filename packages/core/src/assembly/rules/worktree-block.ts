import type { Event } from '../../events/envelope'
import { wrapInSystemReminder } from '../../context/render'
import { activeWorktreeOf, type ActiveWorktree } from '../../workspace/worktree'
import { defineRule, type Rule } from '../rule'

const branchLineOf = (worktree: ActiveWorktree): string => {
  if (!worktree.adopted) {
    return `on branch ${worktree.branch}, branched from ${worktree.base ?? 'the default branch'}.`
  }
  const upstream =
    worktree.base === undefined ? 'which has no upstream' : `which tracks ${worktree.base}`
  return `on branch ${worktree.branch}, ${upstream}. It already existed before this session and Atlas did not create it.`
}

const leavingLineOf = (worktree: ActiveWorktree): string =>
  worktree.adopted
    ? 'Commit and push on this branch. exit_worktree returns the session to the launch directory and leaves this worktree exactly where it is; it will not remove a worktree Atlas did not create.'
    : 'Commit and push on this branch. exit_worktree leaves it, keeping or removing it as the developer asks.'

export function worktreeReminder(args: {
  worktree: ActiveWorktree
  launchDirectory: string
}): string {
  return wrapInSystemReminder(
    [
      `You are working in a git worktree at ${args.worktree.path}, ${branchLineOf(args.worktree)}`,
      'That worktree is the project directory: paths you pass to a tool resolve against it and a bash command starts there.',
      `The repository this worktree belongs to is checked out at ${args.launchDirectory}; leave that checkout alone and reach it only with absolute paths.`,
      leavingLineOf(args.worktree),
    ].join(' '),
  )
}

const lastEventOf = (events: readonly Event[]): Event | undefined => events[events.length - 1]

export function worktreeBlock({ launchDirectory }: { launchDirectory: string }): Rule {
  return defineRule({
    name: 'worktreeBlock',
    apply: (input, ctx) => {
      const worktree = activeWorktreeOf(ctx.events)
      if (worktree === undefined) return input

      const anchor = lastEventOf(ctx.events)
      if (anchor === undefined) return input

      return {
        system: input.system,
        messages: [
          ...input.messages,
          {
            message: {
              role: 'user' as const,
              content: [{ type: 'text' as const, text: worktreeReminder({ worktree, launchDirectory }) }],
            },
            origin: { eventId: anchor.id, seq: anchor.seq },
          },
        ],
      }
    },
  })
}
