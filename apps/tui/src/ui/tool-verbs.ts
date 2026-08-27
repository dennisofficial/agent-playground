import { theme } from './theme'

export enum EToolVerb {
  Read = 'read',
  Grep = 'grep',
  Glob = 'glob',
  Edit = 'edit',
  Write = 'write',
  Bash = 'bash',
  Task = 'task',
  Called = 'called',
}

export enum EVerbTone {
  Neutral = 'neutral',
  Mutating = 'mutating',
  External = 'external',
}

export type ToolNoun = { one: string; many: string }

export type ToolVerb = {
  verb: EToolVerb
  name: string
  spelling: string
  past: string
  participle: string
  noun: ToolNoun
  tone: EVerbTone
}

export const MCP_SEPARATOR = '__'

const FILES: ToolNoun = { one: 'file', many: 'files' }
const PATTERNS: ToolNoun = { one: 'pattern', many: 'patterns' }
const COMMANDS: ToolNoun = { one: 'command', many: 'commands' }
const TASKS: ToolNoun = { one: 'task', many: 'tasks' }
const CALLS: ToolNoun = { one: 'call', many: 'calls' }

type VerbReading = Omit<ToolVerb, 'verb' | 'name'>

const READINGS: Record<EToolVerb, VerbReading> = {
  [EToolVerb.Read]: {
    spelling: 'read',
    past: 'Read',
    participle: 'Reading',
    noun: FILES,
    tone: EVerbTone.Neutral,
  },
  [EToolVerb.Grep]: {
    spelling: 'grep',
    past: 'Searched',
    participle: 'Searching',
    noun: PATTERNS,
    tone: EVerbTone.Neutral,
  },
  [EToolVerb.Glob]: {
    spelling: 'glob',
    past: 'Matched',
    participle: 'Matching',
    noun: PATTERNS,
    tone: EVerbTone.Neutral,
  },
  [EToolVerb.Edit]: {
    spelling: 'edit',
    past: 'Edited',
    participle: 'Editing',
    noun: FILES,
    tone: EVerbTone.Mutating,
  },
  [EToolVerb.Write]: {
    spelling: 'write',
    past: 'Wrote',
    participle: 'Writing',
    noun: FILES,
    tone: EVerbTone.Mutating,
  },
  [EToolVerb.Bash]: {
    spelling: 'bash',
    past: 'Ran',
    participle: 'Running',
    noun: COMMANDS,
    tone: EVerbTone.Mutating,
  },
  [EToolVerb.Task]: {
    spelling: 'task',
    past: 'Delegated',
    participle: 'Delegating',
    noun: TASKS,
    tone: EVerbTone.Mutating,
  },
  [EToolVerb.Called]: {
    spelling: 'call',
    past: 'Called',
    participle: 'Calling',
    noun: CALLS,
    tone: EVerbTone.Neutral,
  },
}

const SPELLINGS: Record<string, EToolVerb> = {
  read: EToolVerb.Read,
  read_file: EToolVerb.Read,
  grep: EToolVerb.Grep,
  search: EToolVerb.Grep,
  glob: EToolVerb.Glob,
  list_dir: EToolVerb.Glob,
  edit: EToolVerb.Edit,
  edit_file: EToolVerb.Edit,
  apply_patch: EToolVerb.Edit,
  write: EToolVerb.Write,
  write_file: EToolVerb.Write,
  bash: EToolVerb.Bash,
  shell: EToolVerb.Bash,
  task: EToolVerb.Task,
  agent: EToolVerb.Task,
}

export function verbOfTool(name: string): ToolVerb {
  const external = name.includes(MCP_SEPARATOR)
  const spelling = name.trim().toLowerCase()
  const known = external ? undefined : SPELLINGS[spelling]

  if (known !== undefined) return { verb: known, name, ...READINGS[known] }

  return {
    verb: EToolVerb.Called,
    name,
    ...READINGS[EToolVerb.Called],
    spelling,
    tone: external ? EVerbTone.External : EVerbTone.Neutral,
  }
}

export const verbIdentity = (verb: ToolVerb): string =>
  verb.verb === EToolVerb.Called ? `${EToolVerb.Called}:${verb.name}` : verb.verb

const nounFor = (args: { noun: ToolNoun; count: number }): string =>
  args.count === 1 ? args.noun.one : args.noun.many

export function settledLabel(args: { verb: ToolVerb; count: number }): string {
  const { verb, count } = args
  if (verb.verb === EToolVerb.Called) return `${verb.past} ${count} × ${verb.name}`
  return `${verb.past} ${count} ${nounFor({ noun: verb.noun, count })}`
}

export function liveLabel(verb: ToolVerb): string {
  if (verb.verb === EToolVerb.Called) return `${verb.participle} ${verb.name}`
  return `${verb.participle} ${verb.noun.many}`
}

const TONE_COLOURS: Record<EVerbTone, string> = {
  [EVerbTone.Neutral]: theme.meta,
  [EVerbTone.Mutating]: theme.ok,
  [EVerbTone.External]: theme.court.external,
}

export const toneColour = (tone: EVerbTone): string => TONE_COLOURS[tone]

