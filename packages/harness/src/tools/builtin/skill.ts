import { z } from 'zod'

import {
  EToolEffect,
  expandSkillBody,
  SchemaTool,
  TAKES_NO_PATHS,
  type ToolOutcome,
  type ToolRun,
} from '@dltech/atlas-core'

import {  portToken } from '../../container/injection'
import { SkillRegistryPort } from '../../skills/port'
import type { DiscoveredSkill } from '../../skills/skill'

const SUGGESTION_LIMIT = 3

const inputSchema = z.strictObject({
  name: z.string().min(1),
  arguments: z.string().optional(),
})

const description = [
  'Load a skill: a packaged set of instructions someone already wrote for one kind of work, which becomes your procedure for it.',
  'Call this whenever a skill listed in your system prompt covers the task in front of you, and call it before planning an approach of your own, because the packaged instructions know things about this workspace that you cannot infer.',
  'Pass name exactly as the listing spells it. Pass arguments only when the task has a subject the skill should be pointed at; most skills need none.',
  'The result is the skill text, and when the skill bundles files of its own it also names the directory it lives in, so every relative path the instructions mention resolves beneath that directory.',
].join(' ')

function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index)

  for (let row = 1; row <= left.length; row += 1) {
    const current = [row]
    for (let column = 1; column <= right.length; column += 1) {
      const matched = left[row - 1] === right[column - 1]
      current.push(
        Math.min(
          (previous[column - 1] ?? 0) + (matched ? 0 : 1),
          (previous[column] ?? 0) + 1,
          (current[column - 1] ?? 0) + 1,
        ),
      )
    }
    previous = current
  }

  return previous[right.length] ?? 0
}

const farthestWorthSuggesting = (args: { requested: string; name: string }): number =>
  Math.ceil(Math.max(args.requested.length, args.name.length) / 2)

function nearestNames(args: { requested: string; names: readonly string[] }): readonly string[] {
  return args.names
    .map((name) => ({ name, distance: editDistance(args.requested, name) }))
    .filter(
      (one) =>
        one.distance <= farthestWorthSuggesting({ requested: args.requested, name: one.name }),
    )
    .sort((left, right) => left.distance - right.distance || left.name.localeCompare(right.name))
    .slice(0, SUGGESTION_LIMIT)
    .map((one) => one.name)
}

function unknownSkillReason(args: {
  requested: string
  known: readonly DiscoveredSkill[]
}): string {
  const names = args.known.filter((one) => one.modelInvocable).map((one) => one.spec.name)

  if (names.length === 0) return `no skill is named ${args.requested}, and none is available to you`

  const nearest = nearestNames({ requested: args.requested, names })

  if (nearest.length === 0) {
    return `no skill is named ${args.requested}; the listing in your system prompt names the ones you have`
  }

  return `no skill is named ${args.requested}; the closest are ${nearest.join(', ')}`
}

function modelTextFor({ skill, body }: { skill: DiscoveredSkill; body: string }): string {
  if (skill.directory === undefined) return body

  return [
    `The ${skill.spec.name} skill is installed at ${skill.directory}. Every relative path below names a file inside that directory, so read one by joining it onto that path rather than onto the project directory.`,
    body,
  ].join('\n\n')
}

export class SkillTool extends SchemaTool<typeof inputSchema> {
  readonly name = 'skill'
  readonly description = description
  readonly effect = EToolEffect.Read
  readonly inputSchema = inputSchema
  override readonly pathFields = TAKES_NO_PATHS
  override readonly isConcurrencySafe = (): boolean => true

  constructor( private readonly skills: SkillRegistryPort) {
    super()
  }

  protected override async run({ input }: ToolRun<typeof inputSchema>): Promise<ToolOutcome> {
    const requested = input.name.trim().toLowerCase()
    const found = this.skills.byName(requested)

    if (found === undefined) {
      return { ok: false, reason: unknownSkillReason({ requested, known: this.skills.all() }) }
    }

    if (!found.modelInvocable) {
      return {
        ok: false,
        reason: `the ${found.spec.name} skill sets disable-model-invocation, so only the developer may reach for it`,
      }
    }

    const argumentText = input.arguments?.trim() ?? ''
    const body = expandSkillBody({ body: found.body, argumentText })

    return {
      ok: true,
      output: {
        name: found.spec.name,
        directory: found.directory,
        path: found.entryPath,
        text: body,
        argumentText,
      },
      modelText: modelTextFor({ skill: found, body }),
    }
  }
}
