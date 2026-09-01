import { EDeed, EDeedRealm, type DeedTarget } from '../../deed'
import { applyToTree, rest, type GitHandler } from './git-tree'
import {
  anyFlag,
  readOnly,
  refTargets,
  routine,
  sketch,
  subverbOf,
  worktreeTarget,
  type CommandView,
} from './view'

const rebaseControlFlags = ['--abort', '--continue', '--skip', '--quit', '--edit-todo']

const readOnlyWorktreeVerbs = new Set(['list', 'prune', 'lock', 'unlock', 'repair'])

const readOnlyConfigFlags = ['--get', '--get-all', '--get-regexp', '--list', '-l']

export const branch: GitHandler = ({ view }) => {
  const named = rest({ view })
  if (anyFlag({ view, flags: ['-D', '-d', '--delete'] })) {
    return sketch({
      action: EDeed.DeleteBranch,
      targets: refTargets({ words: named }),
      summary: 'deletes a branch',
    })
  }

  if (named.length === 0) return readOnly({ summary: 'lists branches' })

  return sketch({
    action: EDeed.WriteFile,
    targets: refTargets({ words: named }),
    summary: 'creates or moves a branch',
  })
}

export const push: GitHandler = ({ view }) => {
  if (view.flags.has('--dry-run')) return readOnly({ summary: 'reports what a push would send' })

  const words = rest({ view })
  const remote = words[0]
  const refs = words.slice(1)
  const targets: readonly DeedTarget[] = [
    ...(remote === undefined ? [] : [{ realm: EDeedRealm.Remote, value: remote.raw }]),
    ...refTargets({ words: refs }),
  ]

  if (anyFlag({ view, flags: ['--delete', '-d'] })) {
    return sketch({
      action: EDeed.DeleteBranch,
      targets,
      summary: 'deletes a branch on the remote',
    })
  }

  const forced =
    anyFlag({ view, flags: ['-f', '--force', '--force-with-lease', '--force-if-includes'] }) ||
    refs.some((word) => word.raw.startsWith('+'))
  if (forced) {
    return sketch({
      action: EDeed.ForcePush,
      targets,
      summary: 'overwrites a branch on the remote',
    })
  }

  return sketch({ action: EDeed.Routine, targets, summary: 'publishes commits to a remote' })
}

export const rebase: GitHandler = ({ view }) => {
  if (anyFlag({ view, flags: rebaseControlFlags })) {
    return applyToTree({ view, summary: 'resumes or abandons a rebase in progress' })
  }

  return sketch({
    action: EDeed.RewriteHistory,
    targets: [worktreeTarget({ view }), ...refTargets({ words: rest({ view }) })],
    summary: 'rewrites local commits onto another base',
  })
}

export const worktree: GitHandler = ({ view }) => {
  const verb = subverbOf({ view })
  if (verb === undefined) return readOnly({ summary: 'lists worktrees' })
  if (readOnlyWorktreeVerbs.has(verb)) {
    return readOnly({ summary: 'reads or tidies worktree bookkeeping' })
  }

  const named = view.words[2]
  const targets = named === undefined ? [] : [{ realm: EDeedRealm.GitWorktree, value: named.path }]

  if (verb === 'remove') {
    return sketch({ action: EDeed.RemoveWorktree, targets, summary: 'removes a worktree' })
  }
  if (verb === 'add') {
    return sketch({ action: EDeed.AddWorktree, targets, summary: 'creates a worktree' })
  }
  if (verb === 'move') {
    return sketch({ action: EDeed.WriteFile, targets, summary: 'moves a worktree' })
  }

  return undefined
}

export const reflog: GitHandler = ({ view }) => {
  const verb = subverbOf({ view })
  if (verb !== 'expire' && verb !== 'delete') return readOnly({ summary: 'reads the reflog' })

  return sketch({
    action: EDeed.RewriteHistory,
    targets: [worktreeTarget({ view })],
    summary: 'drops the reflog entries that make commits recoverable',
  })
}

export const collectGarbage: GitHandler = ({ view }) => {
  if (!view.flags.has('--prune')) return routine({ summary: 'repacks the object store' })

  return sketch({
    action: EDeed.RewriteHistory,
    targets: [worktreeTarget({ view })],
    summary: 'prunes the unreachable objects that make lost commits recoverable',
  })
}

export const rewriteEveryCommit: GitHandler = ({ view }) =>
  sketch({
    action: EDeed.RewriteHistory,
    targets: [worktreeTarget({ view })],
    summary: 'rewrites every commit in the repository',
  })

export const config: GitHandler = ({ view }) => {
  if (anyFlag({ view, flags: readOnlyConfigFlags })) {
    return readOnly({ summary: 'reads git configuration' })
  }
  if (rest({ view }).length < 2) return readOnly({ summary: 'reads git configuration' })

  return applyToTree({ view, summary: 'writes git configuration' })
}

export const remote: GitHandler = ({ view }) => {
  const verb = subverbOf({ view })
  if (verb === undefined || verb === 'show' || verb === 'get-url') {
    return readOnly({ summary: 'lists remotes' })
  }

  return sketch({
    action: EDeed.WriteFile,
    targets: [{ realm: EDeedRealm.Remote, value: view.words[2]?.raw ?? '' }],
    summary: 'changes which remote the repository tracks',
  })
}

export const tag: GitHandler = ({ view }) => {
  const named = rest({ view })
  if (anyFlag({ view, flags: ['-d', '--delete'] })) {
    return sketch({
      action: EDeed.DeleteBranch,
      targets: refTargets({ words: named }),
      summary: 'deletes a tag',
    })
  }
  if (named.length === 0 || anyFlag({ view, flags: ['-l', '--list'] })) {
    return readOnly({ summary: 'lists tags' })
  }

  return sketch({
    action: EDeed.WriteFile,
    targets: refTargets({ words: named }),
    summary: 'creates a tag',
  })
}
