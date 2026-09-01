import { EDeed, type DeedTarget } from '../../deed'
import {
  anyFlag,
  pathTargets,
  readOnly,
  refTargets,
  sketch,
  subverbOf,
  verbOf,
  worktreeTarget,
  type CommandView,
  type CommandWord,
  type DeedSketch,
} from './view'

export type GitHandler = (args: { view: CommandView }) => DeedSketch | undefined

const wholeTreeSpecs = new Set(['.', ':/', '*'])

const readOnlyStashVerbs = new Set(['list', 'show'])

export function rest({ view }: { view: CommandView }): readonly CommandWord[] {
  return view.words.slice(1)
}

export function applyToTree({ view, summary }: { view: CommandView; summary: string }): DeedSketch {
  return sketch({ action: EDeed.WriteFile, targets: [worktreeTarget({ view })], summary })
}

function pathspecTargets({ view }: { view: CommandView }): readonly DeedTarget[] {
  const specs = rest({ view })
  if (specs.length === 0) return [worktreeTarget({ view })]

  const treeWide = specs.some(
    (word) => wholeTreeSpecs.has(word.raw) || (view.cwd !== undefined && word.path === view.cwd),
  )
  if (treeWide) return [worktreeTarget({ view })]

  return pathTargets({ words: specs })
}

function discards({ view }: { view: CommandView }): boolean {
  if (verbOf({ view }) === 'restore') return !view.flags.has('--staged')
  return view.flags.has('--')
}

export const checkout: GitHandler = ({ view }) => {
  if (discards({ view })) {
    return sketch({
      action: EDeed.DiscardWorkingTree,
      targets: pathspecTargets({ view }),
      summary: 'discards uncommitted changes in the working tree',
    })
  }

  return sketch({
    action: EDeed.WriteFile,
    targets: [worktreeTarget({ view }), ...refTargets({ words: rest({ view }) })],
    summary: 'moves the working tree to another commit',
  })
}

export const reset: GitHandler = ({ view }) => {
  if (!view.flags.has('--hard')) {
    return sketch({
      action: EDeed.WriteFile,
      targets: [worktreeTarget({ view })],
      summary: 'moves the branch pointer and the index',
    })
  }

  return sketch({
    action: EDeed.DiscardWorkingTree,
    targets: [worktreeTarget({ view }), ...refTargets({ words: rest({ view }) })],
    summary: 'discards every uncommitted change in the working tree',
  })
}

export const clean: GitHandler = ({ view }) => {
  if (anyFlag({ view, flags: ['-n', '--dry-run'] })) {
    return readOnly({ summary: 'lists what a clean would remove' })
  }

  return sketch({
    action: EDeed.CleanUntracked,
    targets: pathspecTargets({ view }),
    summary: 'removes untracked files',
  })
}

export const stash: GitHandler = ({ view }) => {
  const verb = subverbOf({ view })
  if (verb !== undefined && readOnlyStashVerbs.has(verb)) {
    return readOnly({ summary: 'reads the stash stack' })
  }

  return sketch({
    action: EDeed.MutateStash,
    targets: [worktreeTarget({ view })],
    summary: 'mutates the repository-wide stash stack',
  })
}

export const commit: GitHandler = ({ view }) => {
  if (view.flags.has('--dry-run'))
    return readOnly({ summary: 'reports what a commit would record' })
  if (view.flags.has('--amend')) {
    return sketch({
      action: EDeed.RewriteHistory,
      targets: [worktreeTarget({ view })],
      summary: 'replaces the last commit',
    })
  }

  return applyToTree({ view, summary: 'records a commit' })
}

export const removeTracked: GitHandler = ({ view }) =>
  sketch({
    action: view.flags.has('--cached') ? EDeed.WriteFile : EDeed.RemovePath,
    targets: pathTargets({ words: rest({ view }) }),
    summary: 'removes tracked files',
  })

export const moveTracked: GitHandler = ({ view }) =>
  sketch({
    action: EDeed.WriteFile,
    targets: pathTargets({ words: rest({ view }) }),
    summary: 'moves tracked files',
  })
