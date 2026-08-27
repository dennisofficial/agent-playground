import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

import {
  AfterToolHook,
  EContentAccess,
  EStage,
  ToolDefinition,
  type AfterTool,
  type DeclaredPathField,
  type HookOrder,
  type ToolCall,
  type ToolDeclaration,
} from '@dltech/atlas-core'

import { inject, injectAll, injectable, portToken } from '../container/injection'
import { FileReadStatePort } from '../files/read-state'
import { ABSENT, inputFieldOf } from '../tools/declared-paths'

@injectable()
export class RecordFileStateHook extends AfterToolHook {
  readonly name = 'recordFileState'
  readonly order: HookOrder = { stage: EStage.Observe, nudge: 0 }

  private readonly seen: FileReadStatePort
  private readonly declarations: Map<string, ToolDeclaration>

  constructor(
    @inject(portToken(FileReadStatePort)) seen: FileReadStatePort,
    @injectAll(portToken(ToolDefinition)) tools: readonly ToolDeclaration[],
  ) {
    super()
    this.seen = seen
    this.declarations = new Map(tools.map((tool) => [tool.name, tool]))
  }

  readonly run: AfterTool = async ({ call, result }) => {
    if (!result.ok) return {}

    const declaration = this.declarations.get(call.name)
    if (declaration === undefined) return {}

    for (const declared of declaration.pathFields ?? []) {
      await this.recordField({ call, declaration, declared })
    }

    return {}
  }

  private async recordField(args: {
    call: ToolCall
    declaration: ToolDeclaration
    declared: DeclaredPathField
  }): Promise<void> {
    const { call, declaration, declared } = args
    if (declared.content === EContentAccess.None) return

    const value = inputFieldOf({ input: call.input, field: declared.field })
    if (value === ABSENT || typeof value !== 'string' || !isAbsolute(value)) return

    const stats = await stat(value).catch(() => null)
    if (stats === null || !stats.isFile()) return

    this.seen.record({
      path: value,
      view: {
        mtimeMs: stats.mtimeMs,
        size: stats.size,
        wholeFile: this.breadthOf({ content: declared.content, declaration, call, path: value }),
      },
    })
  }

  private breadthOf(args: {
    content: EContentAccess
    declaration: ToolDeclaration
    call: ToolCall
    path: string
  }): boolean {
    if (args.content === EContentAccess.Overwrites) return true
    if (args.content === EContentAccess.Amends) return this.seen.viewOf(args.path)?.wholeFile ?? true

    return args.declaration.revealsWholeFile?.(args.call.input) ?? false
  }
}

export const createRecordFileStateHook = (args: {
  seen: FileReadStatePort
  tools: readonly ToolDeclaration[]
}): AfterToolHook => new RecordFileStateHook(args.seen, args.tools)
