import { qualifiedName, type EDefinitionOrigin } from '@dltech/atlas-core'

import { SkillRegistryPort } from './port'
import { readSkillSources } from './registry'
import { SkillSource, type DiscoveredSkill } from './skill'

export type SkillSources = () => readonly SkillSource[] | Promise<readonly SkillSource[]>

class ToleratedSkillSource extends SkillSource {
  readonly origin: EDefinitionOrigin
  private readonly inner: SkillSource

  constructor(args: { inner: SkillSource }) {
    super()
    this.inner = args.inner
    this.origin = args.inner.origin
  }

  async load(): Promise<readonly DiscoveredSkill[]> {
    try {
      return await this.inner.load()
    } catch {
      return []
    }
  }
}

const keyed = (skills: readonly DiscoveredSkill[]): ReadonlyMap<string, DiscoveredSkill> => {
  const keys = new Map<string, DiscoveredSkill>()
  for (const skill of skills) keys.set(qualifiedName(skill.spec).toLowerCase(), skill)
  for (const skill of skills) keys.set(skill.spec.name, skill)
  return keys
}

export class LiveSkillRegistry extends SkillRegistryPort {
  private readonly sources: SkillSources
  private held: readonly DiscoveredSkill[] = []
  private keys: ReadonlyMap<string, DiscoveredSkill> = new Map()

  constructor(args: { sources: SkillSources }) {
    super()
    this.sources = args.sources
  }

  all(): readonly DiscoveredSkill[] {
    return this.held
  }

  byName(name: string): DiscoveredSkill | undefined {
    return this.keys.get(name.trim().toLowerCase())
  }

  async reload(): Promise<readonly DiscoveredSkill[]> {
    const skills = await this.read()
    this.held = skills
    this.keys = keyed(skills)
    return skills
  }

  private async read(): Promise<readonly DiscoveredSkill[]> {
    const planned = await this.planned()
    const tolerated = planned.map((inner) => new ToleratedSkillSource({ inner }))
    return (await readSkillSources({ sources: tolerated })).skills
  }

  private async planned(): Promise<readonly SkillSource[]> {
    try {
      return await this.sources()
    } catch {
      return []
    }
  }
}
