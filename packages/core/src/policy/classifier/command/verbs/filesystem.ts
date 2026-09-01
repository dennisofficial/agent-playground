import { EDeed, EDeedRealm, type DeedTarget } from '../../deed'
import {
  anyFlag,
  pathTargets,
  sketch,
  type CommandView,
  type CommandWord,
  type DeedSketch,
  type VerbTable,
} from './view'

const removingPrograms = new Set(['rm', 'rmdir', 'unlink', 'shred', 'truncate'])

const writingPrograms = new Set(['cp', 'ln', 'mkdir', 'touch', 'tee', 'install', 'dd'])

const permissionPrograms = new Set(['chmod', 'chown', 'chgrp'])

const destructiveWordsInsideFind = new Set(['rm', 'rmdir', 'shred', 'unlink', 'mv', 'truncate'])

const findExecFlags = ['-exec', '-execdir', '-ok', '-okdir']

const discardedRedirects = new Set(['/dev/null', '/dev/stdout', '/dev/stderr'])

function firstWordOrCwd({ view }: { view: CommandView }): readonly CommandWord[] {
  const head = view.words[0]
  if (head !== undefined) return [head]
  if (view.cwd === undefined) return []
  return [{ raw: view.cwd, path: view.cwd }]
}

function findSketch({ view }: { view: CommandView }): DeedSketch | undefined {
  if (view.flags.has('-delete')) {
    return sketch({
      action: EDeed.RemovePath,
      targets: pathTargets({ words: firstWordOrCwd({ view }) }),
      summary: 'deletes every matching file below a directory',
    })
  }

  if (!anyFlag({ view, flags: findExecFlags })) return undefined
  if (!view.words.some((word) => destructiveWordsInsideFind.has(word.raw))) return undefined

  return sketch({
    action: EDeed.RemovePath,
    targets: pathTargets({ words: firstWordOrCwd({ view }) }),
    summary: 'runs a removing command over every match below a directory',
  })
}

function inPlaceEdit({ view }: { view: CommandView }): DeedSketch | undefined {
  if (!anyFlag({ view, flags: ['-i', '--in-place'] })) return undefined

  return sketch({
    action: EDeed.WriteFile,
    targets: pathTargets({ words: view.words.slice(1) }),
    summary: 'rewrites files in place',
  })
}

export function redirectTargets({ view }: { view: CommandView }): readonly DeedTarget[] {
  return view.redirectsInto
    .filter((target) => !discardedRedirects.has(target))
    .map((value) => ({ realm: EDeedRealm.Path, value }))
}

export const filesystemVerbs: VerbTable = ({ view }) => {
  const { program, words } = view

  if (program === 'find') return findSketch({ view })
  if (program === 'sed' || program === 'perl') return inPlaceEdit({ view })

  if (removingPrograms.has(program)) {
    return sketch({
      action: EDeed.RemovePath,
      targets: pathTargets({ words }),
      summary: 'removes files',
    })
  }

  if (program === 'mv') {
    return sketch({
      action: EDeed.RemovePath,
      targets: pathTargets({ words }),
      summary: 'moves files, leaving nothing at the source',
    })
  }

  if (program === 'rsync') {
    const destination = words.slice(-1)
    if (view.flags.has('--delete')) {
      return sketch({
        action: EDeed.RemovePath,
        targets: pathTargets({ words: destination }),
        summary: 'mirrors a directory, deleting whatever the source lacks',
      })
    }
    return sketch({
      action: EDeed.WriteFile,
      targets: pathTargets({ words: destination }),
      summary: 'copies files into a directory',
    })
  }

  if (permissionPrograms.has(program)) {
    return sketch({
      action: EDeed.WriteFile,
      targets: pathTargets({ words: words.slice(1) }),
      summary: 'changes file permissions or ownership',
    })
  }

  if (writingPrograms.has(program)) {
    const destination = program === 'cp' || program === 'install' ? words.slice(-1) : words
    return sketch({
      action: EDeed.WriteFile,
      targets: pathTargets({ words: destination }),
      summary: 'writes files',
    })
  }

  return undefined
}
