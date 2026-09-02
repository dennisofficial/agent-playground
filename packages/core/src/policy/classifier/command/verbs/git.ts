import {
  branch,
  collectGarbage,
  config,
  push,
  rebase,
  reflog,
  remote,
  rewriteEveryCommit,
  tag,
  worktree,
} from './git-refs'
import {
  applyToTree,
  checkout,
  clean,
  commit,
  moveTracked,
  pull,
  removeTracked,
  reset,
  rest,
  stash,
  type GitHandler,
} from './git-tree'
import { readOnly, routine, verbOf, type VerbTable } from './view'

const readOnlyVerbs = new Set([
  'annotate',
  'blame',
  'bugreport',
  'cat-file',
  'check-attr',
  'check-ignore',
  'cherry',
  'count-objects',
  'describe',
  'diff',
  'diff-tree',
  'fetch',
  'for-each-ref',
  'fsck',
  'grep',
  'help',
  'log',
  'ls-files',
  'ls-remote',
  'ls-tree',
  'merge-base',
  'name-rev',
  'range-diff',
  'rev-list',
  'rev-parse',
  'shortlog',
  'show',
  'show-branch',
  'show-ref',
  'status',
  'symbolic-ref',
  'var',
  'verify-commit',
  'version',
  'whatchanged',
])

const bareVerbsThatOnlyReport = new Set(['checkout', 'restore'])

const handlers = new Map<string, GitHandler>([
  ['add', () => routine({ summary: 'stages changes for the next commit' })],
  ['am', ({ view }) => applyToTree({ view, summary: 'applies a mailbox of patches' })],
  ['apply', ({ view }) => applyToTree({ view, summary: 'applies a patch to the working tree' })],
  ['branch', branch],
  ['checkout', checkout],
  [
    'cherry-pick',
    ({ view }) => applyToTree({ view, summary: 'replays a commit onto this branch' }),
  ],
  ['clean', clean],
  ['clone', ({ view }) => applyToTree({ view, summary: 'clones a repository' })],
  ['commit', commit],
  ['config', config],
  ['filter-branch', rewriteEveryCommit],
  ['filter-repo', rewriteEveryCommit],
  ['gc', collectGarbage],
  ['init', ({ view }) => applyToTree({ view, summary: 'initialises a repository' })],
  [
    'merge',
    ({ view }) => applyToTree({ view, summary: 'merges another commit into the working tree' }),
  ],
  ['mv', moveTracked],
  ['pull', pull],
  ['push', push],
  ['rebase', rebase],
  ['reflog', reflog],
  ['remote', remote],
  ['reset', reset],
  ['restore', checkout],
  ['revert', ({ view }) => applyToTree({ view, summary: 'records a commit undoing another' })],
  ['rm', removeTracked],
  ['stash', stash],
  [
    'switch',
    ({ view }) => applyToTree({ view, summary: 'moves the working tree to another branch' }),
  ],
  ['tag', tag],
  ['worktree', worktree],
])

export const gitVerbs: VerbTable = ({ view }) => {
  if (view.program !== 'git') return undefined

  const verb = verbOf({ view })
  if (verb === undefined) return readOnly({ summary: 'reports git usage' })
  if (readOnlyVerbs.has(verb)) return readOnly({ summary: `reads repository state (git ${verb})` })

  const bare = rest({ view }).length === 0 && view.flags.size === 0
  if (bare && bareVerbsThatOnlyReport.has(verb)) {
    return readOnly({ summary: `reads repository state (git ${verb})` })
  }

  return handlers.get(verb)?.({ view })
}
