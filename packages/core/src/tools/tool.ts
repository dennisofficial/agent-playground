import { z, type ZodType } from 'zod'

import type { CallId } from '../events/ids'

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

export const TAKES_NO_PATHS: readonly DeclaredPathField[] = []

export type ToolCall = { callId: CallId; name: string; input: unknown; effect: EToolEffect }

export type ToolOutcome =
  | { ok: true; output: unknown; modelText: string }
  | { ok: false; reason: string }

export type ToolDeclaration = {
  name: string
  description: string
  effect: EToolEffect
  inputSchema: ZodType
  pathFields?: readonly DeclaredPathField[]
  isConcurrencySafe?(input: unknown): boolean
  revealsWholeFile?(input: unknown): boolean
}

export type ToolInvocation = { input: unknown; signal: AbortSignal; idempotencyKey: string }

export type ToolRun<TSchema extends ZodType> = {
  input: z.output<TSchema>
  signal: AbortSignal
  idempotencyKey: string
}

export abstract class ToolDefinition<TSchema extends ZodType = ZodType> {
  abstract readonly name: string
  abstract readonly description: string
  abstract readonly effect: EToolEffect
  abstract readonly inputSchema: TSchema
  readonly pathFields?: readonly DeclaredPathField[]
  isConcurrencySafe?(input: z.output<TSchema>): boolean
  revealsWholeFile?(input: z.output<TSchema>): boolean

  abstract invoke(args: ToolInvocation): Promise<ToolOutcome>
}

export abstract class SchemaTool<TSchema extends ZodType = ZodType> extends ToolDefinition<TSchema> {
  override readonly pathFields: readonly DeclaredPathField[] = TAKES_NO_PATHS

  protected abstract run(args: ToolRun<TSchema>): Promise<ToolOutcome>

  override async invoke({ input, signal, idempotencyKey }: ToolInvocation): Promise<ToolOutcome> {
    const parsed = this.inputSchema.safeParse(input)
    if (!parsed.success) {
      return { ok: false, reason: `${this.name} was called with invalid input: ${z.prettifyError(parsed.error)}` }
    }

    return await this.run({ input: parsed.data, signal, idempotencyKey })
  }
}
