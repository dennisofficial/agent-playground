import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

import {
  AfterToolHook,
  declaredFieldsOf,
  EContentAccess,
  EStage,
  ToolDefinition,
  type AfterTool,
  type DeclaredPathField,
  type HookOrder,
  type ThreadId,
  type ToolCall,
  type ToolDeclaration,
} from '@dltech/atlas-core'

import {  portToken } from '../container/injection'
import { digestOf } from '../files/digest'
import { FileReadStatePort } from '../files/read-state'
import { movedSince } from '../files/staleness'
import { ABSENT, inputFieldOf } from '../tools/declared-paths'

export class RecordFileStateHook extends AfterToolHook {
  readonly name = 'recordFileState'
  readonly order: HookOrder = { stage: EStage.Observe, nudge: 0 }

  private readonly seen: FileReadStatePort
  private readonly declarations: Map<string, ToolDeclaration>

  constructor(
     seen: FileReadStatePort,
     tools: readonly ToolDeclaration[],
  ) {
    super()
    this.seen = seen
    this.declarations = new Map(tools.map((tool) => [tool.name, tool]))
  }

  readonly run: AfterTool = async ({ call, result }) => {
    if (!result.ok) return {}

    const declaration = this.declarations.get(call.name)
    if (declaration === undefined) return {}

    for (const declared of declaredFieldsOf({ claim: declaration.pathFields })) {
      await this.recordField({ call, declaration, declared, output: result.output })
    }

    for (const path of declaration.revealsLinesOf?.({ input: call.input, output: result.output }) ??
      []) {
      await this.recordLinesShown({ threadId: call.threadId, path })
    }

    return {}
  }

  /**
   * A call that showed some of a file's lines proves only that much was seen, so an earlier
   * whole-file view survives it only while that view is still the file on disk. Carrying a stale
   * one forward would license a whole-file overwrite of content nobody has read.
   */
  private async recordLinesShown({
    threadId,
    path,
  }: {
    threadId: ThreadId
    path: string
  }): Promise<void> {
    if (!isAbsolute(path)) return

    const stats = await stat(path).catch(() => null)
    if (stats === null || !stats.isFile()) return

    const digest = await digestOf({ path })
    if (digest === undefined) return

    const known = this.seen.viewOf({ threadId, path })
    const wholeFile = known !== undefined && !(await movedSince({ view: known, stats, path })) && known.wholeFile

    this.seen.record({
      threadId,
      path,
      view: { mtimeMs: stats.mtimeMs, size: stats.size, wholeFile, digest },
    })
  }

  private async recordField(args: {
    call: ToolCall
    declaration: ToolDeclaration
    declared: DeclaredPathField
    output: unknown
  }): Promise<void> {
    const { call, declaration, declared, output } = args
    if (declared.content === EContentAccess.None) return

    const value = inputFieldOf({ input: call.input, field: declared.field })
    if (value === ABSENT || typeof value !== 'string' || !isAbsolute(value)) return

    const stats = await stat(value).catch(() => null)
    if (stats === null || !stats.isFile()) return

    const digest = await digestOf({ path: value })
    if (digest === undefined) return

    this.seen.record({
      threadId: call.threadId,
      path: value,
      view: {
        mtimeMs: stats.mtimeMs,
        size: stats.size,
        digest,
        wholeFile: this.breadthOf({
          content: declared.content,
          declaration,
          call,
          output,
          path: value,
        }),
      },
    })
  }

  private breadthOf(args: {
    content: EContentAccess
    declaration: ToolDeclaration
    call: ToolCall
    output: unknown
    path: string
  }): boolean {
    if (args.content === EContentAccess.Overwrites) return true
    if (args.content === EContentAccess.Amends) {
      return this.seen.viewOf({ threadId: args.call.threadId, path: args.path })?.wholeFile ?? true
    }

    return (
      args.declaration.revealsWholeFile?.({ input: args.call.input, output: args.output }) ?? false
    )
  }
}

export const createRecordFileStateHook = (args: {
  seen: FileReadStatePort
  tools: readonly ToolDeclaration[]
}): AfterToolHook => new RecordFileStateHook(args.seen, args.tools)
