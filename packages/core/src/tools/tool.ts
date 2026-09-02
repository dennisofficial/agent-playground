import { z, type ZodType } from 'zod'

import { EWorktreeExit } from '../events/body'
import type { CallId, ThreadId } from '../events/ids'
import type { ImagePart, TextPart } from '../message/parts'
import type { ActiveWorktree } from '../workspace/worktree'

export enum EToolEffect {
  Read = 'read',
  Write = 'write',
  Destructive = 'destructive',
}

export enum EPathPresence {
  Required = 'required',
  Optional = 'optional',
}

export enum EPathForm {
  Absolute = 'absolute',
  RelativeToBase = 'relative-to-base',
}

export enum EContentAccess {
  None = 'none',
  Reads = 'reads',
  Amends = 'amends',
  Overwrites = 'overwrites',
}

export type DeclaredPathField = {
  field: string
  presence: EPathPresence
  form: EPathForm
  content: EContentAccess
}

export enum EPathClaim {
  TouchesNoPaths = 'touches-no-paths',
  PathsItCannotName = 'paths-it-cannot-name',
}

export type PathFieldClaim = EPathClaim | readonly DeclaredPathField[]

export const TAKES_NO_PATHS = EPathClaim.TouchesNoPaths

export const TOUCHES_PATHS_IT_CANNOT_NAME = EPathClaim.PathsItCannotName

export function declaredFieldsOf({
  claim,
}: {
  claim: PathFieldClaim | undefined
}): readonly DeclaredPathField[] {
  if (claim === undefined || typeof claim === 'string') return []
  return claim
}

export type ToolCall = {
  callId: CallId
  name: string
  input: unknown
  effect: EToolEffect
  threadId: ThreadId
}

export type ModelPart = TextPart | ImagePart

export type ToolOutcome =
  | {
      ok: true
      output: unknown
      modelText: string
      modelParts?: readonly ModelPart[] | undefined
    }
  | { ok: false; reason: string }

export type WorktreeEntry = {
  path: string
  branch: string
  base?: string | undefined
  adopted?: boolean | undefined
}

export type WorktreeEntered = { enteredWorktree: WorktreeEntry }

export type WorktreeExited = { exitedWorktree: { path: string; action: EWorktreeExit } }

export function enteredWorktreeOf(output: unknown): WorktreeEntry | undefined {
  if (typeof output !== 'object' || output === null) return undefined

  const entered = (output as Partial<WorktreeEntered>).enteredWorktree
  if (entered === undefined) return undefined

  const { path, branch, base, adopted } = entered
  if (typeof path !== 'string' || path.length === 0) return undefined
  if (typeof branch !== 'string' || branch.length === 0) return undefined
  if (base !== undefined && (typeof base !== 'string' || base.length === 0)) return undefined
  if (adopted !== undefined && typeof adopted !== 'boolean') return undefined

  return {
    path,
    branch,
    ...(base === undefined ? {} : { base }),
    ...(adopted === undefined ? {} : { adopted }),
  }
}

export function exitedWorktreeOf(output: unknown): WorktreeExited['exitedWorktree'] | undefined {
  if (typeof output !== 'object' || output === null) return undefined

  const exited = (output as Partial<WorktreeExited>).exitedWorktree
  if (exited === undefined) return undefined

  const { path, action } = exited
  if (typeof path !== 'string' || path.length === 0) return undefined
  if (action !== EWorktreeExit.Keep && action !== EWorktreeExit.Remove) return undefined

  return { path, action }
}

export type WholeFileClaim<TInput> = { input: TInput; output: unknown }

export type RevealedLines<TInput> = { input: TInput; output: unknown }

export type ToolDeclaration = {
  name: string
  description: string
  effect: EToolEffect
  inputSchema: ZodType
  jsonSchema?: unknown
  pathFields?: PathFieldClaim
  isConcurrencySafe?(input: unknown): boolean
  revealsWholeFile?(args: WholeFileClaim<unknown>): boolean
  revealsLinesOf?(args: RevealedLines<unknown>): readonly string[]
}

export type ToolInvocation = {
  input: unknown
  signal: AbortSignal
  idempotencyKey: string
  projectDirectory: string
  activeWorktree?: ActiveWorktree | undefined
  threadId: ThreadId
}

export type ToolRun<TSchema extends ZodType> = {
  input: z.output<TSchema>
  signal: AbortSignal
  idempotencyKey: string
  projectDirectory: string
  activeWorktree: ActiveWorktree | undefined
  threadId: ThreadId
}

export abstract class ToolDefinition<TSchema extends ZodType = ZodType> {
  abstract readonly name: string
  abstract readonly description: string
  abstract readonly effect: EToolEffect
  abstract readonly inputSchema: TSchema
  readonly pathFields?: PathFieldClaim
  isConcurrencySafe?(input: z.output<TSchema>): boolean
  revealsWholeFile?(args: WholeFileClaim<z.output<TSchema>>): boolean
  revealsLinesOf?(args: RevealedLines<z.output<TSchema>>): readonly string[]

  abstract invoke(args: ToolInvocation): Promise<ToolOutcome>
}

export abstract class SchemaTool<TSchema extends ZodType = ZodType> extends ToolDefinition<TSchema> {
  abstract override readonly pathFields: PathFieldClaim

  protected abstract run(args: ToolRun<TSchema>): Promise<ToolOutcome>

  override async invoke({
    input,
    signal,
    idempotencyKey,
    projectDirectory,
    activeWorktree,
    threadId,
  }: ToolInvocation): Promise<ToolOutcome> {
    const parsed = this.inputSchema.safeParse(input)
    if (!parsed.success) {
      return { ok: false, reason: `${this.name} was called with invalid input: ${z.prettifyError(parsed.error)}` }
    }

    return await this.run({
      input: parsed.data,
      signal,
      idempotencyKey,
      projectDirectory,
      activeWorktree,
      threadId,
    })
  }
}
