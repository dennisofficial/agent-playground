import type { DiscoveredSkill } from '@dltech/atlas-harness'

export type SkillsReloaded = {
  loaded: number
  added: readonly string[]
  removed: readonly string[]
}

const namesOf = (skills: readonly DiscoveredSkill[]): readonly string[] =>
  skills.map((skill) => skill.spec.name)

const missingFrom = (args: {
  names: readonly string[]
  other: readonly string[]
}): readonly string[] => {
  const held = new Set(args.other)
  return args.names.filter((name) => !held.has(name)).sort()
}

export function reloadedSkills(args: {
  before: readonly DiscoveredSkill[]
  after: readonly DiscoveredSkill[]
}): SkillsReloaded {
  const before = namesOf(args.before)
  const after = namesOf(args.after)

  return {
    loaded: after.length,
    added: missingFrom({ names: after, other: before }),
    removed: missingFrom({ names: before, other: after }),
  }
}

const counted = (loaded: number): string => `${loaded} skill${loaded === 1 ? '' : 's'}`

export function reloadNotice(reloaded: SkillsReloaded): string {
  const changes = [
    ...(reloaded.added.length === 0 ? [] : [`added ${reloaded.added.join(', ')}`]),
    ...(reloaded.removed.length === 0 ? [] : [`dropped ${reloaded.removed.join(', ')}`]),
  ]

  if (changes.length === 0) return `${counted(reloaded.loaded)}, nothing new`

  return `${counted(reloaded.loaded)} — ${changes.join(', ')}`
}
