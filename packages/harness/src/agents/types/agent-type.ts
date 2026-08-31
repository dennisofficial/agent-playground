import {
  EDefinitionOrigin,
  splitFrontmatter,
  toToolEffect,
  type EToolEffect,
} from '@dltech/atlas-core'

export const AGENT_SPAWN_TOOL_NAME = 'agent_spawn'

const ALL_TOOLS = '*'
const NAME_PATTERN = /^[a-z][a-z0-9-]*$/

export type AgentType = {
  name: string
  whenToUse: string
  prompt: string
  tools?: readonly string[] | undefined
  disallowedTools?: readonly string[] | undefined
  model?: string | undefined
  maxEffect?: EToolEffect | undefined
  origin: EDefinitionOrigin
}

export abstract class AgentTypeSource {
  abstract readonly origin: EDefinitionOrigin
  abstract load(): Promise<readonly AgentType[]>
}

const named = (args: { written: string | undefined; fallback: string }): string => {
  const declared = args.written?.trim()
  const chosen = declared === undefined || declared === '' ? args.fallback : declared
  return chosen.trim().toLowerCase()
}

const listed = (written: string | undefined): readonly string[] | undefined => {
  const value = written?.trim()
  if (value === undefined || value === '' || value === ALL_TOOLS) return undefined

  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '' && entry !== ALL_TOOLS)

  return entries.length === 0 ? undefined : entries
}

const optionalText = (written: string | undefined): string | undefined => {
  const value = written?.trim()
  return value === undefined || value === '' ? undefined : value
}

export function parseAgentType(args: {
  text: string
  fallbackName: string
  origin: EDefinitionOrigin
}): AgentType | undefined {
  if (args.text.trim() === '') return undefined

  const { fields, body } = splitFrontmatter(args.text)

  const name = named({ written: fields.get('name'), fallback: args.fallbackName })
  if (!NAME_PATTERN.test(name)) return undefined

  const whenToUse = fields.get('description')?.trim()
  if (whenToUse === undefined || whenToUse === '') return undefined

  const prompt = body.trim()
  if (prompt === '') return undefined

  const writtenEffect = optionalText(fields.get('max-effect'))
  const maxEffect = writtenEffect === undefined ? undefined : toToolEffect(writtenEffect)
  if (writtenEffect !== undefined && maxEffect === undefined) return undefined

  return {
    name,
    whenToUse,
    prompt,
    tools: listed(fields.get('tools')),
    disallowedTools: listed(fields.get('disallowed-tools')),
    model: optionalText(fields.get('model')),
    maxEffect,
    origin: args.origin,
  }
}
