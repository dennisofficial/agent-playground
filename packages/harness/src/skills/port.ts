import type { DiscoveredSkill } from './skill'

export abstract class SkillRegistryPort {
  abstract all(): readonly DiscoveredSkill[]
  abstract byName(name: string): DiscoveredSkill | undefined
  abstract reload(): Promise<readonly DiscoveredSkill[]>
}
