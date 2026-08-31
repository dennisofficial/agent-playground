import { resolveShadowing } from '@dltech/atlas-core'

import { type DiscoveredSkill, type SkillSource } from './skill'

export async function loadSkills(args: {
  sources: readonly SkillSource[]
}): Promise<readonly DiscoveredSkill[]> {
  const loaded = await Promise.all(args.sources.map((source) => source.load()))

  return resolveShadowing({
    definitions: loaded.flat(),
    nameOf: (skill) => skill.spec.name,
  })
}
