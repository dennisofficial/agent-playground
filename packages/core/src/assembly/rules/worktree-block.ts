import { activeWorktreeOf, homeDirectoryOf, type ActiveWorktree } from '../../workspace/worktree'
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
    ? "Commit and push on this branch. exit_worktree returns the session to the repository's main checkout and leaves this worktree exactly where it is; it will not remove a worktree Atlas did not create."
    : "Commit and push on this branch. exit_worktree returns the session to the repository's main checkout, keeping or removing this worktree as the developer asks."

export function worktreeNote(args: {
  worktree: ActiveWorktree
  mainCheckout: string
}): string {
  return [
    `You are working in a git worktree at ${args.worktree.path}, ${branchLineOf(args.worktree)}`,
    'That worktree is the project directory: paths you pass to a tool resolve against it and a bash command starts there.',
    `The repository this worktree belongs to is checked out at ${args.mainCheckout}; leave that checkout alone and reach it only with absolute paths.`,
    leavingLineOf(args.worktree),
  ].join(' ')
}

export function worktreeBlock({
  launchDirectory,
  repoRoot,
}: {
  launchDirectory: string
  repoRoot?: string | undefined
}): Rule {
  return defineRule({
    name: 'worktreeBlock',
    apply: (input, ctx) => {
      const worktree = activeWorktreeOf(ctx.events)
      if (worktree === undefined) return input

      const mainCheckout = repoRoot ?? homeDirectoryOf({ events: ctx.events, launchDirectory })
      return {
        system: [...input.system, { text: worktreeNote({ worktree, mainCheckout }) }],
        messages: input.messages,
      }
    },
  })
}
