import { dirname, isAbsolute } from 'node:path'

import {
  AfterToolHook,
  declaredFieldsOf,
  EStage,
  type AfterTool,
  type EInstructionFamily,
  type EventDraft,
  type FileSystemPort,
  type HookOrder,
  type ToolCall,
  type ToolDeclaration,
} from '@dltech/atlas-core'

import { readNestedInstructionFiles } from '../context/read-instructions'
import { ABSENT, inputFieldOf } from '../tools/declared-paths'

export type NestedInstructionPlan = {
  root: string
  family: EInstructionFamily
  reload: boolean
  enabled: boolean
}

export type NestedInstructionSource = (args: { projectDirectory: string }) => NestedInstructionPlan

const touchedDirectoriesOf = (args: {
  declaration: ToolDeclaration
  input: unknown
}): readonly string[] => {
  const directories = new Set<string>()

  for (const declared of declaredFieldsOf({ claim: args.declaration.pathFields })) {
    const value = inputFieldOf({ input: args.input, field: declared.field })
    if (value === ABSENT || typeof value !== 'string' || !isAbsolute(value)) continue
    directories.add(dirname(value))
  }

  return [...directories]
}

export class NestedInstructionsHook extends AfterToolHook {
  readonly name = 'nestedInstructions'
  readonly order: HookOrder = { stage: EStage.Observe, nudge: 0 }

  private readonly source: NestedInstructionSource
  private readonly declarations: Map<string, ToolDeclaration>
  private readonly files: FileSystemPort | undefined
  private readonly seen = new Set<string>()

  constructor(args: {
    source: NestedInstructionSource
    tools: readonly ToolDeclaration[]
    files?: FileSystemPort | undefined
  }) {
    super()
    this.source = args.source
    this.files = args.files
    this.declarations = new Map(args.tools.map((tool) => [tool.name, tool]))
  }

  readonly run: AfterTool = async ({ call, result, projectDirectory }) => {
    if (!result.ok) return {}

    const declaration = this.declarations.get(call.name)
    if (declaration === undefined) return {}

    const plan = this.source({ projectDirectory })
    if (!plan.enabled) return {}

    const drafts: EventDraft[] = []
    for (const touchedDirectory of touchedDirectoriesOf({
      declaration,
      input: call.input,
    })) {
      const key = `${call.threadId} ${projectDirectory} ${touchedDirectory}`
      if (!plan.reload && this.seen.has(key)) continue
      this.seen.add(key)

      const instructions = await readNestedInstructionFiles({
        root: plan.root,
        cwd: projectDirectory,
        touchedDirectory,
        family: plan.family,
        files: this.files,
      })

      drafts.push(...instructions.map((instruction) => draftOf({ call, instruction })))
    }

    return drafts.length === 0 ? {} : { drafts }
  }
}

const draftOf = (args: {
  call: ToolCall
  instruction: { slot: string; path: string; content: string }
}): EventDraft => ({
  type: 'context-loaded',
  slot: args.instruction.slot,
  key: args.instruction.path,
  content: args.instruction.content,
  triggeredBy: args.call.name,
})
