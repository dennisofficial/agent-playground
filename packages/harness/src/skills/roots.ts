import { realpath, stat } from 'node:fs/promises'
import { sep } from 'node:path'

import type { SkillRoot } from '@dltech/atlas-core'

import { FilesystemSkillSource } from './filesystem-source'
import type { SkillSource } from './skill'

const realDirectoryOf = async (directory: string): Promise<string | undefined> => {
  try {
    const real = await realpath(directory)
    return (await stat(real)).isDirectory() ? real : undefined
  } catch {
    return undefined
  }
}

const isWithin = (args: { path: string; ancestor: string }): boolean => {
  if (args.path === args.ancestor) return true
  const prefix = args.ancestor.endsWith(sep) ? args.ancestor : `${args.ancestor}${sep}`
  return args.path.startsWith(prefix)
}

export async function resolveSkillRoots(args: {
  plan: readonly SkillRoot[]
}): Promise<readonly SkillRoot[]> {
  const accepted: SkillRoot[] = []
  const claimed: string[] = []

  for (const root of args.plan) {
    const real = await realDirectoryOf(root.directory)
    if (real === undefined) continue
    if (claimed.some((ancestor) => isWithin({ path: real, ancestor }))) continue

    claimed.push(real)
    accepted.push(root)
  }

  return accepted
}

export function skillSourcesFor(args: { roots: readonly SkillRoot[] }): readonly SkillSource[] {
  return args.roots.map(
    (root) => new FilesystemSkillSource({ directory: root.directory, origin: root.origin }),
  )
}
