import {
  ECommandGroup,
  ECommandKind,
  EDefinitionOrigin,
  splitFrontmatter,
  type CommandSpec,
} from '@dltech/atlas-core'

export { EDefinitionOrigin as ESkillOrigin }

export type DiscoveredSkill = {
  spec: CommandSpec
  body: string
  origin: EDefinitionOrigin
  userInvocable: boolean
  modelInvocable: boolean
}

export abstract class SkillSource {
  abstract readonly origin: EDefinitionOrigin
  abstract load(): Promise<readonly DiscoveredSkill[]>
}

const flagOf = (args: { written: string | undefined; fallback: boolean }): boolean => {
  const value = args.written?.trim().toLowerCase()
  if (value === 'true') return true
  if (value === 'false') return false
  return args.fallback
}

const named = (args: { written: string | undefined; fallback: string }): string => {
  const declared = args.written?.trim()
  const chosen = declared === undefined || declared === '' ? args.fallback : declared
  return chosen.trim().toLowerCase()
}

export function parseSkill(args: {
  text: string
  fallbackName: string
  origin: EDefinitionOrigin
}): DiscoveredSkill | undefined {
  if (args.text.trim() === '') return undefined

  const { fields, body } = splitFrontmatter(args.text)
  const name = named({ written: fields.get('name'), fallback: args.fallbackName })
  if (name === '') return undefined

  const argumentHint = fields.get('argument-hint')?.trim()

  return {
    spec: {
      name,
      kind: ECommandKind.Skill,
      summary: fields.get('description')?.trim() ?? '',
      group: ECommandGroup.Workspace,
      argumentHint: argumentHint === '' ? undefined : argumentHint,
    },
    body,
    origin: args.origin,
    userInvocable: flagOf({ written: fields.get('user-invocable'), fallback: true }),
    modelInvocable: !flagOf({ written: fields.get('disable-model-invocation'), fallback: false }),
  }
}
