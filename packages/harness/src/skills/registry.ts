import { ESkillOrigin, type DiscoveredSkill, type SkillSource } from './skill'

const SHADOWING_RANK: Readonly<Record<ESkillOrigin, number>> = {
  [ESkillOrigin.BuiltIn]: 0,
  [ESkillOrigin.User]: 1,
  [ESkillOrigin.Project]: 2,
}

export async function loadSkills(args: {
  sources: readonly SkillSource[]
}): Promise<readonly DiscoveredSkill[]> {
  const loaded = await Promise.all(args.sources.map((source) => source.load()))
  const winners = new Map<string, DiscoveredSkill>()

  for (const skill of loaded.flat()) {
    const held = winners.get(skill.spec.name)
    if (held !== undefined && SHADOWING_RANK[held.origin] >= SHADOWING_RANK[skill.origin]) continue
    winners.set(skill.spec.name, skill)
  }

  return [...winners.values()].sort((left, right) => left.spec.name.localeCompare(right.spec.name))
}
