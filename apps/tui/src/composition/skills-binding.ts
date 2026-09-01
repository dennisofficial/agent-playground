import { skillRootPlan } from '@dltech/atlas-core'
import {
  EmbeddedSkillSource,
  LiveSkillRegistry,
  portToken,
  resolveSkillRoots,
  SkillRegistryPort,
  skillSourcesFor,
  type DependencyContainer,
} from '@dltech/atlas-harness'

const SKILLS_DIRECTORY_NAME = 'skills'

export class SkillRegistryNotBound extends Error {
  constructor() {
    super(
      'the skill registry binding did not take, so the embedded-only registry the container ships with is still in place',
    )
  }
}

export function bindSkillRegistry(args: {
  container: DependencyContainer
  registry: SkillRegistryPort
}): SkillRegistryPort {
  const token = portToken(SkillRegistryPort)
  args.container.register(token, { useValue: args.registry })

  if (!args.container.isRegistered(token, true)) throw new SkillRegistryNotBound()

  const resolved = args.container.resolve(token)
  if (resolved !== args.registry) throw new SkillRegistryNotBound()

  return resolved
}

export async function liveSkillRegistry(args: {
  atlasHome: string
  home: string
  cwd: string
}): Promise<SkillRegistryPort> {
  const registry = new LiveSkillRegistry({
    sources: async () => {
      const roots = await resolveSkillRoots({
        plan: skillRootPlan({
          atlasHome: args.atlasHome,
          home: args.home,
          cwd: args.cwd,
          skillsDirectoryName: SKILLS_DIRECTORY_NAME,
        }),
      })

      return [new EmbeddedSkillSource(), ...skillSourcesFor({ roots })]
    },
  })

  await registry.reload()
  return registry
}
