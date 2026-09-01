import { basename } from 'node:path'

import {
  ECommandGroup,
  ECommandKind,
  EDefinitionOrigin,
  parseFrontmatter,
  skillFrontmatterOf,
  validateSkill,
  type CommandSpec,
  type SkillFrontmatter,
  type SkillWarning,
} from '@dltech/atlas-core'

export { EDefinitionOrigin as ESkillOrigin }

export const SKILL_ENTRY_FILENAME = 'SKILL.md'

export const isSkillEntryFilename = (filename: string): boolean =>
  filename.toLowerCase() === SKILL_ENTRY_FILENAME.toLowerCase()

export type DiscoveredSkill = {
  spec: CommandSpec
  body: string
  origin: EDefinitionOrigin
  frontmatter: SkillFrontmatter
  warnings: readonly SkillWarning[]
  directory: string | undefined
  entryPath: string | undefined
  userInvocable: boolean
  modelInvocable: boolean
}

export abstract class SkillSource {
  abstract readonly origin: EDefinitionOrigin
  abstract load(): Promise<readonly DiscoveredSkill[]>
}

const owningDirectoryName = (args: {
  directory: string | undefined
  entryPath: string | undefined
}): string | undefined => {
  if (args.directory === undefined || args.entryPath === undefined) return undefined
  if (!isSkillEntryFilename(basename(args.entryPath))) return undefined
  return basename(args.directory)
}

const hintOf = (written: string | undefined): string | undefined => {
  const trimmed = written?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}

export function parseSkill(args: {
  text: string
  fallbackName: string
  origin: EDefinitionOrigin
  directory?: string | undefined
  entryPath?: string | undefined
}): DiscoveredSkill | undefined {
  if (args.text.trim() === '') return undefined

  const { document, body } = parseFrontmatter(args.text)
  const frontmatter = skillFrontmatterOf({ document, fallbackName: args.fallbackName })
  const name = frontmatter.name.trim().toLowerCase()
  if (name === '') return undefined

  return {
    spec: {
      name,
      kind: ECommandKind.Skill,
      summary: frontmatter.description,
      group: ECommandGroup.Workspace,
      argumentHint: hintOf(frontmatter.argumentHint),
    },
    body,
    origin: args.origin,
    frontmatter,
    warnings: validateSkill({
      frontmatter,
      directoryName: owningDirectoryName({ directory: args.directory, entryPath: args.entryPath }),
    }),
    directory: args.directory,
    entryPath: args.entryPath,
    userInvocable: frontmatter.userInvocable,
    modelInvocable: frontmatter.modelInvocable,
  }
}
