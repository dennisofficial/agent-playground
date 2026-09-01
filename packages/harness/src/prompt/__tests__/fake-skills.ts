import {
  ECommandGroup,
  ECommandKind,
  EDefinitionOrigin,
  ESkillContext,
  ESkillShell,
  type SkillFrontmatter,
} from '@dltech/atlas-core'

import { SkillRegistryPort } from '../../skills/port'
import type { DiscoveredSkill } from '../../skills/skill'

const frontmatterFor = (args: {
  name: string
  description: string
  whenToUse: string | undefined
  modelInvocable: boolean
}): SkillFrontmatter => ({
  name: args.name,
  description: args.description,
  whenToUse: args.whenToUse,
  license: undefined,
  compatibility: undefined,
  metadata: new Map(),
  allowedTools: [],
  disallowedTools: [],
  argumentHint: undefined,
  argumentNames: [],
  userInvocable: true,
  modelInvocable: args.modelInvocable,
  model: undefined,
  effort: undefined,
  context: ESkillContext.Inline,
  agent: undefined,
  background: undefined,
  paths: [],
  shell: ESkillShell.Bash,
  unrecognised: new Map(),
})

export function fakeSkill(args: {
  name: string
  description?: string
  whenToUse?: string
  body?: string
  directory?: string
  entryPath?: string
  modelInvocable?: boolean
}): DiscoveredSkill {
  const description = args.description ?? `does ${args.name} things`
  const modelInvocable = args.modelInvocable ?? true

  return {
    spec: {
      name: args.name,
      kind: ECommandKind.Skill,
      summary: description,
      group: ECommandGroup.Workspace,
      argumentHint: undefined,
    },
    body: args.body ?? `Run the ${args.name} procedure.`,
    origin: EDefinitionOrigin.User,
    frontmatter: frontmatterFor({
      name: args.name,
      description,
      whenToUse: args.whenToUse,
      modelInvocable,
    }),
    warnings: [],
    directory: args.directory,
    entryPath:
      args.entryPath ?? (args.directory === undefined ? undefined : `${args.directory}/SKILL.md`),
    userInvocable: true,
    modelInvocable,
  }
}

export class FakeSkillRegistry extends SkillRegistryPort {
  private skills: readonly DiscoveredSkill[]
  private readonly onReload: () => readonly DiscoveredSkill[]

  constructor(args: {
    skills: readonly DiscoveredSkill[]
    onReload?: () => readonly DiscoveredSkill[]
  }) {
    super()
    this.skills = args.skills
    this.onReload = args.onReload ?? ((): readonly DiscoveredSkill[] => this.skills)
  }

  all(): readonly DiscoveredSkill[] {
    return this.skills
  }

  byName(name: string): DiscoveredSkill | undefined {
    return this.skills.find((skill) => skill.spec.name === name)
  }

  async reload(): Promise<readonly DiscoveredSkill[]> {
    this.skills = this.onReload()
    return this.skills
  }
}
