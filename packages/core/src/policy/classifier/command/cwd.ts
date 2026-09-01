import { basenameOf, parentOf, resolveAgainst } from '../path-set'

const directoryChangers = new Set(['cd', 'pushd', 'popd', 'chdir'])

function join({ base, path }: { base: string | undefined; path: string }): string | undefined {
  if (path.startsWith('/')) return resolveAgainst({ base: '/', path })
  if (base === undefined) return undefined
  if (path.startsWith('~')) return undefined
  return resolveAgainst({ base, path })
}

export function cwdForSegment(args: {
  incoming: string | undefined
  program: string
  flagValues: ReadonlyMap<string, string>
}): string | undefined {
  const { incoming, program, flagValues } = args
  if (program !== 'git') return incoming

  const relocated = flagValues.get('-C')
  const base = relocated === undefined ? incoming : join({ base: incoming, path: relocated })

  const workTree = flagValues.get('--work-tree')
  if (workTree !== undefined) return join({ base, path: workTree })

  const gitDir = flagValues.get('--git-dir')
  if (gitDir === undefined) return base

  const resolvedGitDir = join({ base, path: gitDir })
  if (resolvedGitDir === undefined) return undefined
  if (basenameOf({ path: resolvedGitDir }) !== '.git') return base
  return parentOf({ path: resolvedGitDir })
}

export function cwdAfterSegment(args: {
  incoming: string | undefined
  program: string
  operands: readonly string[]
  operandsAreLiteral: boolean
}): string | undefined {
  const { incoming, program, operands, operandsAreLiteral } = args
  if (!directoryChangers.has(program)) return incoming
  if (program !== 'cd') return undefined
  if (!operandsAreLiteral) return undefined

  const target = operands[0]
  if (target === undefined) return undefined
  if (target === '-') return undefined

  return join({ base: incoming, path: target })
}
