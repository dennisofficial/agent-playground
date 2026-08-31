import { skillRootPlan, type SkillRoot } from '@dltech/atlas-core'

import { resolveSkillRoots } from '../../skills/roots'
import type { AgentTypeSource } from './agent-type'
import { DirectoryAgentTypeSource } from './directory-source'
import { EmbeddedAgentTypeSource } from './embedded-source'

const AGENTS_DIRECTORY_NAME = 'agents'

export function agentTypeRootPlan(args: {
  atlasHome: string
  home: string
  cwd: string
}): readonly SkillRoot[] {
  return skillRootPlan({ ...args, skillsDirectoryName: AGENTS_DIRECTORY_NAME })
}

export function agentTypeSourcesFor(args: {
  roots: readonly SkillRoot[]
}): readonly AgentTypeSource[] {
  return args.roots.map(
    (root) => new DirectoryAgentTypeSource({ directory: root.directory, origin: root.origin }),
  )
}

export async function agentTypeSources(args: {
  atlasHome: string
  home: string
  cwd: string
}): Promise<readonly AgentTypeSource[]> {
  const roots = await resolveSkillRoots({ plan: agentTypeRootPlan(args) })

  return [new EmbeddedAgentTypeSource(), ...agentTypeSourcesFor({ roots })]
}
