import { realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

import { EBeforeToolDecision, EStage, type BeforeTool, type ToolCall } from '@dltech/atlas-core'

import type { RegisteredHook } from './registry'

enum EPathField {
  Required = 'required',
  Optional = 'optional',
}

enum EDenial {
  Escapes = 'escapes',
  Uncheckable = 'uncheckable',
  Malformed = 'malformed',
}

const PATH_FIELD_BY_TOOL: Readonly<Record<string, EPathField>> = {
  read: EPathField.Required,
  write: EPathField.Required,
  edit: EPathField.Required,
  grep: EPathField.Optional,
  glob: EPathField.Optional,
}

type Denial =
  | { kind: EDenial.Escapes; path: string; resolvesTo?: string | undefined }
  | { kind: EDenial.Uncheckable; found: string }
  | { kind: EDenial.Malformed; path: string; fault: string }

const ABSENT = Symbol('absent')

const SCAN_PATTERN_TOOLS: readonly string[] = ['glob']

function scanPatternOf({ call, input }: { call: ToolCall; input: unknown }): string | undefined {
  if (!SCAN_PATTERN_TOOLS.includes(call.name)) return undefined
  if (typeof input !== 'object' || input === null) return undefined
  if (!('pattern' in input)) return undefined
  return typeof input.pattern === 'string' ? input.pattern : undefined
}

function pathFieldOf(input: unknown): unknown {
  if (typeof input !== 'object' || input === null) return ABSENT
  if (!('path' in input)) return ABSENT
  return input.path === undefined ? ABSENT : input.path
}

function contains({ root, target }: { root: string; target: string }): boolean {
  if (target === root) return true
  return target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
}

async function realpathOfNearestExisting(target: string): Promise<string> {
  const missing: string[] = []
  let current = target

  for (;;) {
    try {
      return join(await realpath(current), ...missing)
    } catch {
      const parent = dirname(current)
      if (parent === current) return target
      missing.unshift(basename(current))
      current = parent
    }
  }
}

function reasonFor({ call, denial, root }: { call: ToolCall; denial: Denial; root: string }): string {
  if (denial.kind === EDenial.Uncheckable) {
    return `${call.name} cannot be checked against the workspace root: its path is ${denial.found}`
  }

  if (denial.kind === EDenial.Malformed) {
    return `${call.name} was given ${denial.fault}: ${denial.path}`
  }

  const destination =
    denial.resolvesTo === undefined ? denial.path : `${denial.path}, which resolves to ${denial.resolvesTo}`

  return `${call.name} would reach ${destination}, outside the workspace root ${root}`
}

export function createBoundaryHook(args: { root: string }): RegisteredHook<BeforeTool> {
  const root = resolve(args.root)

  const escapeeOf = async (candidate: string): Promise<string | undefined> => {
    const [realRoot, realTarget] = await Promise.all([
      realpathOfNearestExisting(root),
      realpathOfNearestExisting(candidate),
    ])
    return contains({ root: realRoot, target: realTarget }) ? undefined : realTarget
  }

  const escapeDenial = async (args: { declared: string; candidate: string }): Promise<Denial | undefined> => {
    const escapee = await escapeeOf(args.candidate)
    if (escapee === undefined) return undefined

    return {
      kind: EDenial.Escapes,
      path: args.declared,
      ...(escapee === args.declared ? {} : { resolvesTo: escapee }),
    }
  }

  const declaredPathDenial = async (
    call: ToolCall,
  ): Promise<{ denial: Denial } | { base: string } | undefined> => {
    const requirement = PATH_FIELD_BY_TOOL[call.name]
    if (requirement === undefined) return undefined

    const field = pathFieldOf(call.input)
    if (field === ABSENT) {
      if (requirement === EPathField.Optional) return { base: root }
      return { denial: { kind: EDenial.Uncheckable, found: 'missing' } }
    }

    if (typeof field !== 'string') {
      return { denial: { kind: EDenial.Uncheckable, found: `not a string but a ${typeof field}` } }
    }

    if (field.includes('\0')) {
      return { denial: { kind: EDenial.Malformed, path: field, fault: 'a path containing a NUL byte' } }
    }

    if (!isAbsolute(field)) {
      return { denial: { kind: EDenial.Malformed, path: field, fault: 'a path that is not absolute' } }
    }

    const base = resolve(field)
    const denial = await escapeDenial({ declared: field, candidate: base })
    return denial === undefined ? { base } : { denial }
  }

  const denialFor = async (call: ToolCall): Promise<Denial | undefined> => {
    const declared = await declaredPathDenial(call)
    if (declared === undefined) return undefined
    if ('denial' in declared) return declared.denial

    const pattern = scanPatternOf({ call, input: call.input })
    if (pattern === undefined) return undefined

    if (pattern.includes('\0')) {
      return { kind: EDenial.Malformed, path: pattern, fault: 'a glob pattern containing a NUL byte' }
    }

    return escapeDenial({ declared: pattern, candidate: resolve(declared.base, pattern) })
  }

  return {
    name: 'workspaceBoundary',
    order: { stage: EStage.Guard, nudge: 0 },
    run: async ({ call }) => {
      const denial = await denialFor(call)
      if (denial !== undefined) {
        return { decision: EBeforeToolDecision.Deny, reason: reasonFor({ call, denial, root }) }
      }

      return { decision: EBeforeToolDecision.Allow, input: call.input }
    },
  }
}
