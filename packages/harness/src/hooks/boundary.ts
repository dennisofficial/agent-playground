import { isAbsolute, resolve } from 'node:path'

import { z } from 'zod'

import {
  EBeforeToolDecision,
  EPathForm,
  EPathPresence,
  EStage,
  type BeforeTool,
  type DeclaredPathField,
  type ToolCall,
  type ToolDeclaration,
} from '@dltech/atlas-core'

import { createWorkspaceContainment } from '../tools/containment'
import type { RegisteredHook } from './registry'

enum EDenial {
  Unregistered = 'unregistered',
  Undeclared = 'undeclared',
  Escapes = 'escapes',
  Uncheckable = 'uncheckable',
  Malformed = 'malformed',
}

type Denial =
  | { kind: EDenial.Unregistered }
  | { kind: EDenial.Undeclared }
  | { kind: EDenial.Escapes; path: string; resolvesTo?: string | undefined }
  | { kind: EDenial.Uncheckable; field: string; found: string }
  | { kind: EDenial.Malformed; field: string; path: string; fault: string }

const ABSENT = Symbol('absent')

const inputRecordSchema = z.record(z.string(), z.unknown())

function inputFieldOf({ input, field }: { input: unknown; field: string }): unknown {
  const parsed = inputRecordSchema.safeParse(input)
  if (!parsed.success) return ABSENT

  const value = parsed.data[field]
  return value === undefined ? ABSENT : value
}

const isUsableBase = (value: unknown): value is string =>
  typeof value === 'string' && isAbsolute(value) && !value.includes('\0')

function reasonFor({ call, denial, root }: { call: ToolCall; denial: Denial; root: string }): string {
  if (denial.kind === EDenial.Unregistered) {
    return `${call.name} is not a registered tool, so it cannot be checked against the workspace root`
  }

  if (denial.kind === EDenial.Undeclared) {
    return `${call.name} has not declared which of its inputs hold filesystem paths, so it cannot be checked against the workspace root ${root}`
  }

  if (denial.kind === EDenial.Uncheckable) {
    return `${call.name} cannot be checked against the workspace root: its ${denial.field} is ${denial.found}`
  }

  if (denial.kind === EDenial.Malformed) {
    return `${call.name} was given a ${denial.field} ${denial.fault}: ${denial.path}`
  }

  const destination =
    denial.resolvesTo === undefined ? denial.path : `${denial.path}, which resolves to ${denial.resolvesTo}`

  return `${call.name} would reach ${destination}, outside the workspace root ${root}`
}

export function createBoundaryHook({
  root: workspace,
  tools,
}: {
  root: string
  tools: readonly ToolDeclaration[]
}): RegisteredHook<BeforeTool> {
  const containment = createWorkspaceContainment({ root: workspace })
  const root = containment.root
  const pathFieldsByTool = new Map(tools.map((tool) => [tool.name, tool.pathFields]))

  const escapeDenial = async (args: { declared: string; candidate: string }): Promise<Denial | undefined> => {
    const escapee = await containment.escapeeOf(args.candidate)
    if (escapee === undefined) return undefined

    return {
      kind: EDenial.Escapes,
      path: args.declared,
      ...(escapee === args.declared ? {} : { resolvesTo: escapee }),
    }
  }

  const fieldDenial = async (args: {
    input: unknown
    declared: DeclaredPathField
    base: string
  }): Promise<Denial | undefined> => {
    const { field, presence, form } = args.declared
    const value = inputFieldOf({ input: args.input, field })

    if (value === ABSENT) {
      if (presence === EPathPresence.Optional) return undefined
      return { kind: EDenial.Uncheckable, field, found: 'missing' }
    }

    if (typeof value !== 'string') {
      return { kind: EDenial.Uncheckable, field, found: `not a string but a ${typeof value}` }
    }

    if (value.includes('\0')) {
      return { kind: EDenial.Malformed, field, path: value, fault: 'containing a NUL byte' }
    }

    if (form === EPathForm.Absolute && !isAbsolute(value)) {
      return { kind: EDenial.Malformed, field, path: value, fault: 'that is not absolute' }
    }

    const candidate = form === EPathForm.Absolute ? resolve(value) : resolve(args.base, value)
    return escapeDenial({ declared: value, candidate })
  }

  const baseOf = (args: { input: unknown; declared: readonly DeclaredPathField[] }): string => {
    for (const declared of args.declared) {
      if (declared.form !== EPathForm.Absolute) continue

      const value = inputFieldOf({ input: args.input, field: declared.field })
      if (isUsableBase(value)) return resolve(value)
    }

    return root
  }

  const declaredFieldsFor = (
    name: string,
  ): { denial: Denial } | { declared: readonly DeclaredPathField[] } => {
    if (!pathFieldsByTool.has(name)) return { denial: { kind: EDenial.Unregistered } }

    const declared = pathFieldsByTool.get(name)
    if (declared === undefined) return { denial: { kind: EDenial.Undeclared } }

    return { declared }
  }

  const denialFor = async (call: ToolCall): Promise<Denial | undefined> => {
    const found = declaredFieldsFor(call.name)
    if ('denial' in found) return found.denial

    const byForm = (form: EPathForm) => found.declared.filter((declared) => declared.form === form)

    for (const declared of byForm(EPathForm.Absolute)) {
      const denial = await fieldDenial({ input: call.input, declared, base: root })
      if (denial !== undefined) return denial
    }

    const base = baseOf({ input: call.input, declared: found.declared })

    for (const declared of byForm(EPathForm.RelativeToBase)) {
      const denial = await fieldDenial({ input: call.input, declared, base })
      if (denial !== undefined) return denial
    }

    return undefined
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
