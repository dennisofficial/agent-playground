import type { Event } from '../../events/envelope'
import { wrapInSystemReminder } from '../../context/render'
import { activeWorktreeOf } from '../../workspace/worktree'
import { defineRule, type Rule } from '../rule'

export function worktreeReminder(args: {
  path: string
  branch: string
  base: string
  launchDirectory: string
}): string {
  return wrapInSystemReminder(
    [
      `You are working in a git worktree at ${args.path}, on branch ${args.branch}, branched from ${args.base}.`,
      'That worktree is the project directory: paths you pass to a tool resolve against it and a bash command starts there.',
      `The repository this worktree belongs to is checked out at ${args.launchDirectory}; leave that checkout alone and reach it only with absolute paths.`,
      'Commit and push on this branch. exit_worktree leaves it, keeping or removing it as the developer asks.',
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
              content: [{ type: 'text' as const, text: worktreeReminder({ ...worktree, launchDirectory }) }],
            },
            origin: { eventId: anchor.id, seq: anchor.seq },
          },
        ],
      }
    },
  })
}
