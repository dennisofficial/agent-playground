import { z } from 'zod'

import {
  EContentAccess,
  EPathForm,
  EPathPresence,
  EToolEffect,
  type DeclaredPathField,
  type ToolCall,
} from '../../tools/tool'
import { EReadConfidence, type CommandReading, type CommandSegment } from './command/read-command'
import { filesystemVerbs, redirectTargets } from './command/verbs/filesystem'
import { gitVerbs } from './command/verbs/git'
import { networkVerbs } from './command/verbs/network'
import { packageVerbs } from './command/verbs/packages'
import { processVerbs } from './command/verbs/processes'
import { routineVerbs } from './command/verbs/routine'
import {
  sketch,
  viewOf,
  type CommandView,
  type DeedSketch,
  type VerbTable,
} from './command/verbs/view'
import { EDeed, EDeedRealm, type Deed, type DeedTarget } from './deed'
import { resolveAgainst } from './path-set'

export enum EPathDeclaration {
  Unregistered = 'unregistered',
  Undeclared = 'undeclared',
  TouchesNoPaths = 'touches-no-paths',
  Declared = 'declared',
}

export type PathDeclarationView =
  | { kind: EPathDeclaration.Unregistered }
  | { kind: EPathDeclaration.Undeclared }
  | { kind: EPathDeclaration.TouchesNoPaths }
  | { kind: EPathDeclaration.Declared; fields: readonly DeclaredPathField[] }

const VERB_TABLES: readonly VerbTable[] = [
  gitVerbs,
  filesystemVerbs,
  packageVerbs,
  networkVerbs,
  processVerbs,
  routineVerbs,
]

const QUIET_ACTIONS: ReadonlySet<EDeed> = new Set([EDeed.Routine, EDeed.ReadOnly])

const inputRecordSchema = z.record(z.string(), z.unknown())

function declaredValue({ input, field }: { input: unknown; field: string }): string | undefined {
  const parsed = inputRecordSchema.safeParse(input)
  if (!parsed.success) return undefined

  const value = parsed.data[field]
  if (typeof value !== 'string' || value.length === 0) return undefined
  return value
}

function declaredTargets(args: {
  input: unknown
  fields: readonly DeclaredPathField[]
  projectDirectory: string
}): readonly DeedTarget[] {
  return args.fields.flatMap((field) => {
    const value = declaredValue({ input: args.input, field: field.field })
    if (value === undefined) return []

    const path =
      field.form === EPathForm.Absolute
        ? value
        : resolveAgainst({ base: args.projectDirectory, path: value })
    return [{ realm: EDeedRealm.Path, value: path }]
  })
}

function deedOf(args: { call: ToolCall; cwd: string | undefined; sketch: DeedSketch }): Deed {
  return {
    action: args.sketch.action,
    toolName: args.call.name,
    targets: args.sketch.targets,
    cwd: args.cwd,
    summary: args.sketch.summary,
  }
}

function unreadable({ summary }: { summary: string }): DeedSketch {
  return sketch({ action: EDeed.Unreadable, summary })
}

function withRedirects({ view, drafted }: { view: CommandView; drafted: DeedSketch }): DeedSketch {
  const written = redirectTargets({ view })
  if (written.length === 0) return drafted

  const quiet = QUIET_ACTIONS.has(drafted.action)

  return sketch({
    action: quiet ? EDeed.WriteFile : drafted.action,
    targets: [...drafted.targets, ...written],
    summary: quiet ? 'writes a file through a shell redirect' : drafted.summary,
  })
}

function sketchOf({ segment }: { segment: CommandSegment }): DeedSketch {
  const view = viewOf({ segment })

  for (const table of VERB_TABLES) {
    const drafted = table({ view })
    if (drafted !== undefined) return withRedirects({ view, drafted })
  }

  return withRedirects({
    view,
    drafted: unreadable({ summary: `an unclassified command (${view.program})` }),
  })
}

function opaqueDeed({ call, reading }: { call: ToolCall; reading: CommandReading }): Deed {
  const programs = [...new Set(reading.segments.map((segment) => segment.program))]
  const cwds = [
    ...new Set(
      reading.segments
        .map((segment) => segment.cwd)
        .filter((cwd): cwd is string => cwd !== undefined),
    ),
  ]

  return {
    action: EDeed.Unreadable,
    toolName: call.name,
    targets: cwds.map((value) => ({ realm: EDeedRealm.Path, value })),
    cwd: reading.segments[0]?.cwd,
    summary:
      programs.length === 0
        ? 'a command the reader could not parse'
        : `a command the reader could only partly parse (${programs.join(', ')})`,
  }
}

function bashDeeds({
  call,
  reading,
}: {
  call: ToolCall
  reading: CommandReading
}): readonly Deed[] {
  if (reading.confidence === EReadConfidence.Opaque) return [opaqueDeed({ call, reading })]

  return reading.segments.map((segment) =>
    deedOf({ call, cwd: segment.cwd, sketch: sketchOf({ segment }) }),
  )
}

function declaredDeeds(args: {
  call: ToolCall
  fields: readonly DeclaredPathField[]
  projectDirectory: string
}): readonly Deed[] {
  const { call, fields, projectDirectory } = args
  const writes = fields.filter(
    (field) =>
      field.content === EContentAccess.Overwrites || field.content === EContentAccess.Amends,
  )
  const written = declaredTargets({ input: call.input, fields: writes, projectDirectory })

  if (written.length > 0) {
    return [
      deedOf({
        call,
        cwd: undefined,
        sketch: sketch({
          action: EDeed.WriteFile,
          targets: written,
          summary: `${call.name} writes a file`,
        }),
      }),
    ]
  }

  const blind = unreadable({ summary: `${call.name} does not say which paths it touches` })
  if (writes.some((field) => field.presence === EPathPresence.Required)) {
    return [deedOf({ call, cwd: undefined, sketch: blind })]
  }

  if (writes.length > 0) {
    return [
      deedOf({
        call,
        cwd: undefined,
        sketch: sketch({
          action: EDeed.Routine,
          summary: `${call.name} was given none of the paths it can write`,
        }),
      }),
    ]
  }

  if (call.effect !== EToolEffect.Read) return [deedOf({ call, cwd: undefined, sketch: blind })]

  return [
    deedOf({
      call,
      cwd: undefined,
      sketch: sketch({
        action: EDeed.ReadOnly,
        targets: declaredTargets({ input: call.input, fields, projectDirectory }),
        summary: `${call.name} reads without changing anything`,
      }),
    }),
  ]
}

export function deedsOf(args: {
  call: ToolCall
  declaration: PathDeclarationView
  reading: CommandReading | undefined
  projectDirectory: string
}): readonly Deed[] {
  const { call, declaration, reading, projectDirectory } = args

  if (declaration.kind === EPathDeclaration.Unregistered) {
    return [
      deedOf({
        call,
        cwd: undefined,
        sketch: unreadable({ summary: `${call.name} is not a registered tool` }),
      }),
    ]
  }

  if (reading !== undefined) return bashDeeds({ call, reading })

  if (declaration.kind === EPathDeclaration.TouchesNoPaths) {
    return [
      deedOf({
        call,
        cwd: undefined,
        sketch: sketch({
          action: EDeed.Routine,
          summary: `${call.name} touches no path of its own`,
        }),
      }),
    ]
  }

  if (declaration.kind === EPathDeclaration.Undeclared) {
    return [
      deedOf({
        call,
        cwd: undefined,
        sketch: unreadable({ summary: `${call.name} declares no paths` }),
      }),
    ]
  }

  return declaredDeeds({ call, fields: declaration.fields, projectDirectory })
}
