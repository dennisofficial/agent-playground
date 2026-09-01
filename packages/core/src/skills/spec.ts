import type { YamlMap } from '../yaml/value'

export enum ESkillContext {
  Inline = 'inline',
  Fork = 'fork',
}

export enum ESkillShell {
  Bash = 'bash',
  PowerShell = 'powershell',
}

export enum ESkillEffort {
  Low = 'low',
  Medium = 'medium',
  High = 'high',
  XHigh = 'xhigh',
  Max = 'max',
}

export enum ESkillWarning {
  MissingName = 'missing-name',
  MissingDescription = 'missing-description',
  NameTooLong = 'name-too-long',
  NameCharset = 'name-charset',
  NameHyphenEdges = 'name-hyphen-edges',
  NameDoubleHyphen = 'name-double-hyphen',
  NameDirectoryMismatch = 'name-directory-mismatch',
  DescriptionTooLong = 'description-too-long',
  CompatibilityTooLong = 'compatibility-too-long',
  MetadataNotAMap = 'metadata-not-a-map',
  UnknownField = 'unknown-field',
}

export const SKILL_NAME_MAX_LENGTH = 64
export const SKILL_DESCRIPTION_MAX_LENGTH = 1024
export const SKILL_COMPATIBILITY_MAX_LENGTH = 500

export type SkillWarning = { code: ESkillWarning; detail: string }

export type SkillFrontmatter = {
  name: string
  description: string
  whenToUse: string | undefined
  license: string | undefined
  compatibility: string | undefined
  metadata: ReadonlyMap<string, string>
  allowedTools: readonly string[]
  disallowedTools: readonly string[]
  argumentHint: string | undefined
  argumentNames: readonly string[]
  userInvocable: boolean
  modelInvocable: boolean
  model: string | undefined
  effort: ESkillEffort | undefined
  context: ESkillContext
  agent: string | undefined
  background: boolean | undefined
  paths: readonly string[]
  shell: ESkillShell
  unrecognised: YamlMap
}
