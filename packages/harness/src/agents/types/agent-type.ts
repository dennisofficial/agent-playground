import {
  EDefinitionOrigin,
  splitFrontmatter,
  toToolEffect,
  type EToolEffect,
} from '@dltech/atlas-core'

export const AGENT_SPAWN_TOOL_NAME = 'agent_spawn'

export const AGENT_TOOL_NAMES: readonly string[] = [
  AGENT_SPAWN_TOOL_NAME,
  'agent_say',
  'agent_resume',
  'agent_list',
  'agent_stop',
]

export const WORKTREE_TOOL_NAMES: readonly string[] = [
  'enter_worktree',
  'exit_worktree',
  'worktree_list',
]

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
  definedIn?: string | undefined
}

export enum EAgentTypeRefusal {
  Empty = 'empty',
  BadName = 'bad-name',
  NoDescription = 'no-description',
  NoPrompt = 'no-prompt',
  BadMaxEffect = 'bad-max-effect',
  UnusableModel = 'unusable-model',
  Unreadable = 'unreadable',
}

export type AgentTypeRefusal = {
  refusal: EAgentTypeRefusal
  name: string | undefined
  definedIn: string | undefined
  origin: EDefinitionOrigin
  detail: string
}

export type AgentTypeRead = {
  types: readonly AgentType[]
  refusals: readonly AgentTypeRefusal[]
}

export type ParsedAgentType =
  | { ok: true; agentType: AgentType }
  | { ok: false; refusal: EAgentTypeRefusal; name: string; detail: string }

export abstract class AgentTypeSource {
  abstract readonly origin: EDefinitionOrigin
  abstract load(): Promise<AgentTypeRead>
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

const BAD_NAME =
  'a name must start with a letter and hold only lowercase letters, digits and hyphens, because the model passes it verbatim to agent_spawn'

const NO_DESCRIPTION =
  'there is no description: line in the frontmatter, and that line is how the model chooses this agent type'

const NO_PROMPT =
  'there is nothing below the frontmatter, so the agent type has no prompt to run on'

const EMPTY = 'the file is empty'

export function parseAgentType(args: {
  text: string
  fallbackName: string
  origin: EDefinitionOrigin
  definedIn?: string | undefined
}): ParsedAgentType {
  const refused = (refusal: EAgentTypeRefusal, detail: string): ParsedAgentType => ({
    ok: false,
    refusal,
    name: args.fallbackName,
    detail,
  })

  if (args.text.trim() === '') return refused(EAgentTypeRefusal.Empty, EMPTY)

  const { fields, body } = splitFrontmatter(args.text)

  const name = named({ written: fields.get('name'), fallback: args.fallbackName })
  if (!NAME_PATTERN.test(name)) {
    return refused(EAgentTypeRefusal.BadName, `"${name}" cannot name an agent type: ${BAD_NAME}`)
  }

  const whenToUse = fields.get('description')?.trim()
  if (whenToUse === undefined || whenToUse === '') {
    return refused(EAgentTypeRefusal.NoDescription, NO_DESCRIPTION)
  }

  const prompt = body.trim()
  if (prompt === '') return refused(EAgentTypeRefusal.NoPrompt, NO_PROMPT)

  const writtenEffect = optionalText(fields.get('max-effect'))
  const maxEffect = writtenEffect === undefined ? undefined : toToolEffect(writtenEffect)
  if (writtenEffect !== undefined && maxEffect === undefined) {
    return refused(
      EAgentTypeRefusal.BadMaxEffect,
      `max-effect: "${writtenEffect}" is not one of read, write or destructive`,
    )
  }

  return {
    ok: true,
    agentType: {
      name,
      whenToUse,
      prompt,
      tools: listed(fields.get('tools')),
      disallowedTools: listed(fields.get('disallowed-tools')),
      model: optionalText(fields.get('model')),
      maxEffect,
      origin: args.origin,
      definedIn: args.definedIn,
    },
  }
}
