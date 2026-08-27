import { isAbsolute, resolve } from 'node:path'

import { z } from 'zod'

import {
  BeforeToolHook,
  EBeforeToolDecision,
  EPathForm,
  EPathPresence,
  EStage,
  type BeforeTool,
  type DeclaredPathField,
  type HookOrder,
  type ToolCall,
  type ToolDeclaration,
} from '@dltech/atlas-core'

import { createWorkspaceContainment, type WorkspaceContainment } from '../tools/containment'

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

export class WorkspaceBoundaryHook extends BeforeToolHook {
  readonly name = 'workspaceBoundary'
  readonly order: HookOrder = { stage: EStage.Guard, nudge: 0 }

  private readonly containment: WorkspaceContainment
  private readonly root: string
  private readonly pathFieldsByTool: Map<string, readonly DeclaredPathField[] | undefined>

  constructor(root: string, tools: readonly ToolDeclaration[]) {
    super()
    this.containment = createWorkspaceContainment({ root })
    this.root = this.containment.root
    this.pathFieldsByTool = new Map(tools.map((tool) => [tool.name, tool.pathFields]))
  }

  readonly run: BeforeTool = async ({ call }) => {
    const denial = await this.denialFor(call)
    if (denial !== undefined) {
      return { decision: EBeforeToolDecision.Deny, reason: reasonFor({ call, denial, root: this.root }) }
    }

    return { decision: EBeforeToolDecision.Allow, input: call.input }
  }

  private async escapeDenial(args: { declared: string; candidate: string }): Promise<Denial | undefined> {
    const escapee = await this.containment.escapeeOf(args.candidate)
    if (escapee === undefined) return undefined

    return {
      kind: EDenial.Escapes,
      path: args.declared,
      ...(escapee === args.declared ? {} : { resolvesTo: escapee }),
    }
  }

  private async fieldDenial(args: {
    input: unknown
    declared: DeclaredPathField
    base: string
  }): Promise<Denial | undefined> {
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
    return this.escapeDenial({ declared: value, candidate })
  }

  private baseOf(args: { input: unknown; declared: readonly DeclaredPathField[] }): string {
    for (const declared of args.declared) {
      if (declared.form !== EPathForm.Absolute) continue

      const value = inputFieldOf({ input: args.input, field: declared.field })
      if (isUsableBase(value)) return resolve(value)
    }

    return this.root
  }

  private declaredFieldsFor(name: string): { denial: Denial } | { declared: readonly DeclaredPathField[] } {
    if (!this.pathFieldsByTool.has(name)) return { denial: { kind: EDenial.Unregistered } }

    const declared = this.pathFieldsByTool.get(name)
    if (declared === undefined) return { denial: { kind: EDenial.Undeclared } }

    return { declared }
  }

  private async denialFor(call: ToolCall): Promise<Denial | undefined> {
    const found = this.declaredFieldsFor(call.name)
    if ('denial' in found) return found.denial

    const byForm = (form: EPathForm) => found.declared.filter((declared) => declared.form === form)

    for (const declared of byForm(EPathForm.Absolute)) {
      const denial = await this.fieldDenial({ input: call.input, declared, base: this.root })
      if (denial !== undefined) return denial
    }

    const base = this.baseOf({ input: call.input, declared: found.declared })

    for (const declared of byForm(EPathForm.RelativeToBase)) {
      const denial = await this.fieldDenial({ input: call.input, declared, base })
      if (denial !== undefined) return denial
    }

    return undefined
  }
}

export const createBoundaryHook = (args: {
  root: string
  tools: readonly ToolDeclaration[]
}): BeforeToolHook => new WorkspaceBoundaryHook(args.root, args.tools)
