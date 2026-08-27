import type { Stats } from 'node:fs'
import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

import {
  BeforeToolHook,
  EBeforeToolDecision,
  EContentAccess,
  EStage,
  ToolDefinition,
  type BeforeTool,
  type DeclaredPathField,
  type HookOrder,
  type ToolCall,
  type ToolDeclaration,
} from '@dltech/atlas-core'

import { inject, injectAll, injectable, portToken } from '../container/injection'
import { FileReadStatePort } from '../files/read-state'
import {
  ABSENT,
  createDeclaredPaths,
  EPathDeclaration,
  inputFieldOf,
  type DeclaredPaths,
} from '../tools/declared-paths'

enum EDenial {
  Unverifiable = 'unverifiable',
  Unread = 'unread',
  Stale = 'stale',
  Partial = 'partial',
}

type Denial =
  | { kind: EDenial.Unverifiable; path: string; fault: string }
  | { kind: EDenial.Unread; path: string }
  | { kind: EDenial.Stale; path: string }
  | { kind: EDenial.Partial; path: string }

enum EStatus {
  Absent = 'absent',
  Unverifiable = 'unverifiable',
  Present = 'present',
}

type FileStatus =
  | { kind: EStatus.Absent }
  | { kind: EStatus.Unverifiable; fault: string }
  | { kind: EStatus.Present; stats: Stats }

const errorCodeOf = (error: unknown): string =>
  error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'unknown'

async function statusOf(path: string): Promise<FileStatus> {
  try {
    return { kind: EStatus.Present, stats: await stat(path) }
  } catch (error) {
    const fault = errorCodeOf(error)
    if (fault === 'ENOENT') return { kind: EStatus.Absent }

    return { kind: EStatus.Unverifiable, fault }
  }
}

function reasonFor({ call, denial }: { call: ToolCall; denial: Denial }): string {
  if (denial.kind === EDenial.Unverifiable) {
    return `${call.name} would rewrite ${denial.path}, but its current state could not be checked (${denial.fault}); the write is refused rather than risk overwriting a change nobody has seen`
  }

  if (denial.kind === EDenial.Unread) {
    return `${call.name} would rewrite ${denial.path}, which has not been read; read it first so the write is based on what the file actually contains`
  }

  if (denial.kind === EDenial.Stale) {
    return `${call.name} would rewrite ${denial.path}, which has changed since it was read, either by the user or by a formatter; read it again before writing to it`
  }

  return `${call.name} would replace all of ${denial.path}, but only part of it has been read; read the whole file first, or use edit to change the part you have seen`
}

const writesContent = (declared: DeclaredPathField): boolean =>
  declared.content === EContentAccess.Amends || declared.content === EContentAccess.Overwrites

function checkablePathOf({ input, field }: { input: unknown; field: string }): string | undefined {
  const value = inputFieldOf({ input, field })
  if (value === ABSENT || typeof value !== 'string') return undefined
  if (!isAbsolute(value) || value.includes('\0')) return undefined

  return value
}

@injectable()
export class ReadBeforeWriteHook extends BeforeToolHook {
  readonly name = 'readBeforeWrite'
  readonly order: HookOrder = { stage: EStage.Guard, nudge: 1 }

  private readonly declaredPaths: DeclaredPaths

  constructor(
    @inject(portToken(FileReadStatePort)) private readonly seen: FileReadStatePort,
    @injectAll(portToken(ToolDefinition)) tools: readonly ToolDeclaration[],
  ) {
    super()
    this.declaredPaths = createDeclaredPaths({ tools })
  }

  readonly run: BeforeTool = async ({ call }) => {
    const denial = await this.denialFor(call)
    if (denial !== undefined) {
      return { decision: EBeforeToolDecision.Deny, reason: reasonFor({ call, denial }) }
    }

    return { decision: EBeforeToolDecision.Allow, input: call.input }
  }

  private async fieldDenial(args: {
    input: unknown
    declared: DeclaredPathField
  }): Promise<Denial | undefined> {
    const path = checkablePathOf({ input: args.input, field: args.declared.field })
    if (path === undefined) return undefined

    const status = await statusOf(path)
    if (status.kind === EStatus.Absent) return undefined
    if (status.kind === EStatus.Unverifiable) {
      return { kind: EDenial.Unverifiable, path, fault: status.fault }
    }

    const stats = status.stats
    if (!stats.isFile()) return undefined

    const view = this.seen.viewOf(path)
    if (view === undefined) return { kind: EDenial.Unread, path }

    if (view.mtimeMs !== stats.mtimeMs || view.size !== stats.size) {
      return { kind: EDenial.Stale, path }
    }

    if (args.declared.content === EContentAccess.Overwrites && !view.wholeFile) {
      return { kind: EDenial.Partial, path }
    }

    return undefined
  }

  private async denialFor(call: ToolCall): Promise<Denial | undefined> {
    const declaration = this.declaredPaths.forTool(call.name)
    if (declaration.kind !== EPathDeclaration.Declared) return undefined

    for (const declared of declaration.fields.filter(writesContent)) {
      const denial = await this.fieldDenial({ input: call.input, declared })
      if (denial !== undefined) return denial
    }

    return undefined
  }
}

export const createReadBeforeWriteHook = (args: {
  seen: FileReadStatePort
  tools: readonly ToolDeclaration[]
}): BeforeToolHook => new ReadBeforeWriteHook(args.seen, args.tools)
