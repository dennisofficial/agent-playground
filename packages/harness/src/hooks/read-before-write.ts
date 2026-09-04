import { isAbsolute } from 'node:path'

import {
  BeforeToolHook,
  EBeforeToolDecision,
  EContentAccess,
  EStage,
  ToolDefinition,
  type BeforeTool,
  type DeclaredPathField,
  type FileStat,
  type FileSystemPort,
  type HookOrder,
  type ThreadId,
  type ToolCall,
  type ToolDeclaration,
} from '@dltech/atlas-core'

import { LocalFileSystemPort } from '../execution/local-filesystem'
import { FileReadStatePort } from '../files/read-state'
import { movedSince } from '../files/staleness'
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

type Denial = { path: string; content: EContentAccess } & (
  | { kind: EDenial.Unverifiable; fault: string }
  | { kind: EDenial.Unread }
  | { kind: EDenial.Stale }
  | { kind: EDenial.Partial }
)

enum EStatus {
  Absent = 'absent',
  Unverifiable = 'unverifiable',
  Present = 'present',
}

type FileStatus =
  | { kind: EStatus.Absent }
  | { kind: EStatus.Unverifiable; fault: string }
  | { kind: EStatus.Present; stats: FileStat }

const errorCodeOf = (error: unknown): string =>
  error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'unknown'

async function statusOf(args: { path: string; files: FileSystemPort }): Promise<FileStatus> {
  try {
    return { kind: EStatus.Present, stats: await args.files.stat({ path: args.path }) }
  } catch (error) {
    const fault = errorCodeOf(error)
    if (fault === 'ENOENT') return { kind: EStatus.Absent }

    return { kind: EStatus.Unverifiable, fault }
  }
}

const attemptOf = ({ call, denial }: { call: ToolCall; denial: Denial }): string =>
  denial.content === EContentAccess.Overwrites
    ? `${call.name} would replace all of ${denial.path}`
    : `${call.name} would change part of ${denial.path}`

function reasonFor({ call, denial }: { call: ToolCall; denial: Denial }): string {
  const attempt = attemptOf({ call, denial })

  if (denial.kind === EDenial.Unverifiable) {
    return `${attempt}, but its current state could not be checked (${denial.fault}); the change is refused rather than risk overwriting something nobody has seen`
  }

  if (denial.kind === EDenial.Unread) {
    return `${attempt}, which has not been read; read it first so nothing it holds is lost unseen`
  }

  if (denial.kind === EDenial.Stale) {
    return `${attempt}, which has changed since it was read, either by the user or by a formatter; read it again before writing to it`
  }

  return `${attempt}, but only part of it has been read; read the whole file first, or use edit to change the part you have seen`
}

const writesContent = (declared: DeclaredPathField): boolean =>
  declared.content === EContentAccess.Amends || declared.content === EContentAccess.Overwrites

function checkablePathOf({ input, field }: { input: unknown; field: string }): string | undefined {
  const value = inputFieldOf({ input, field })
  if (value === ABSENT || typeof value !== 'string') return undefined
  if (!isAbsolute(value) || value.includes('\0')) return undefined

  return value
}

export class ReadBeforeWriteHook extends BeforeToolHook {
  readonly name = 'readBeforeWrite'
  readonly order: HookOrder = { stage: EStage.Guard, nudge: 1 }

  private readonly declaredPaths: DeclaredPaths

  constructor(
    private readonly seen: FileReadStatePort,
    tools: readonly ToolDeclaration[],
    private readonly files: FileSystemPort = new LocalFileSystemPort(),
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
    threadId: ThreadId
    input: unknown
    declared: DeclaredPathField
  }): Promise<Denial | undefined> {
    const path = checkablePathOf({ input: args.input, field: args.declared.field })
    if (path === undefined) return undefined

    const content = args.declared.content
    const status = await statusOf({ path, files: this.files })
    if (status.kind === EStatus.Absent) return undefined
    if (status.kind === EStatus.Unverifiable) {
      return { kind: EDenial.Unverifiable, path, content, fault: status.fault }
    }

    const stats = status.stats
    if (!stats.isFile()) return undefined

    const view = this.seen.viewOf({ threadId: args.threadId, path })
    if (view === undefined) {
      return content === EContentAccess.Overwrites
        ? { kind: EDenial.Unread, path, content }
        : undefined
    }

    if (await movedSince({ view, stats, path, files: this.files })) {
      return { kind: EDenial.Stale, path, content }
    }

    if (content === EContentAccess.Overwrites && !view.wholeFile) {
      return { kind: EDenial.Partial, path, content }
    }

    return undefined
  }

  private async denialFor(call: ToolCall): Promise<Denial | undefined> {
    const declaration = this.declaredPaths.forTool(call.name)
    if (declaration.kind !== EPathDeclaration.Declared) return undefined

    for (const declared of declaration.fields.filter(writesContent)) {
      const denial = await this.fieldDenial({
        threadId: call.threadId,
        input: call.input,
        declared,
      })
      if (denial !== undefined) return denial
    }

    return undefined
  }
}

export const createReadBeforeWriteHook = (args: {
  seen: FileReadStatePort
  tools: readonly ToolDeclaration[]
  files?: FileSystemPort | undefined
}): BeforeToolHook => new ReadBeforeWriteHook(args.seen, args.tools, args.files)
