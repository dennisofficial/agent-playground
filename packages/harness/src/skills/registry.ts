import { resolveShadowing } from '@dltech/atlas-core'

import { type DiscoveredSkill, type SkillSource } from './skill'

export type SkillLoad = {
  skills: readonly DiscoveredSkill[]
  shadowed: readonly DiscoveredSkill[]
}

export async function readSkillSources(args: {
  sources: readonly SkillSource[]
}): Promise<SkillLoad> {
  const loaded = await Promise.all(args.sources.map((source) => source.load()))
  const discovered = loaded.flat()
  const skills = resolveShadowing({
    definitions: discovered,
    nameOf: (skill) => skill.spec.name,
  })
  const kept = new Set(skills)

  return { skills, shadowed: discovered.filter((skill) => !kept.has(skill)) }
}

export async function loadSkills(args: {
  sources: readonly SkillSource[]
}): Promise<readonly DiscoveredSkill[]> {
  return (await readSkillSources(args)).skills
}
