import { commandLineOf, mentionSpans } from './mention'
import { ECommandKind, qualifiedName, type CommandSpec } from './spec'

export type Invocation = { spec: CommandSpec; argumentText: string }

export type Submission = {
  local: Invocation | null
  skills: readonly Invocation[]
}

const SEGMENT_BREAK = /[:\-_]/

function index(specs: readonly CommandSpec[]): ReadonlyMap<string, CommandSpec> {
  const byName = new Map<string, CommandSpec>()

  for (const spec of specs) byName.set(qualifiedName(spec), spec)

  for (const spec of specs) {
    const held = byName.get(spec.name)
    if (held === undefined || (held.kind === ECommandKind.Local && spec.kind === ECommandKind.Skill)) {
      byName.set(spec.name, spec)
    }
  }

  return byName
}

export function resolveSubmission(args: {
  text: string
  specs: readonly CommandSpec[]
}): Submission {
  const known = index(args.specs)
  const mentions = mentionSpans(args.text)
  const line = commandLineOf(args.text)

  const leading = mentions.slice(0, line?.names.length ?? 0)
  const trailing = mentions.slice(line?.names.length ?? 0)

  const first = leading[0] === undefined ? undefined : known.get(leading[0].name)
  if (first !== undefined && first.kind === ECommandKind.Local) {
    return { local: { spec: first, argumentText: line?.argumentText ?? '' }, skills: [] }
  }

  const collected = new Map<string, Invocation>()

  const collect = ({ name, argumentText }: { name: string; argumentText: string }): void => {
    const spec = known.get(name)
    if (spec === undefined || spec.kind !== ECommandKind.Skill) return
    if (collected.has(spec.name)) return
    collected.set(spec.name, { spec, argumentText })
  }

  for (const mention of leading) {
    collect({ name: mention.name, argumentText: line?.argumentText ?? '' })
  }
  for (const mention of trailing) collect({ name: mention.name, argumentText: args.text })

  return { local: null, skills: [...collected.values()] }
}

export function activeQuery(text: string): string | null {
  let start = text.length
  while (start > 0) {
    const character = text[start - 1]
    if (character === undefined || !/[A-Za-z0-9:-]/.test(character)) break
    start -= 1
  }

  if (text[start - 1] !== '/') return null

  const before = start - 1 === 0 ? undefined : text[start - 2]
  if (before !== undefined && !/\s/.test(before)) return null

  return text.slice(start)
}

const matches = ({ name, query }: { name: string; query: string }): boolean => {
  const lowered = name.toLowerCase()
  if (lowered.startsWith(query)) return true
  return lowered.split(SEGMENT_BREAK).some((segment) => segment.startsWith(query))
}

export function commandCandidates(args: {
  text: string
  specs: readonly CommandSpec[]
}): readonly CommandSpec[] {
  const query = activeQuery(args.text)
  if (query === null) return []

  const lowered = query.toLowerCase()
  return args.specs.filter((spec) => matches({ name: spec.name, query: lowered }))
}
