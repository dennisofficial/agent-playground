import type { ZodType } from 'zod'

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

export type DeclaredPathField = {
  field: string
  presence: EPathPresence
  form: EPathForm
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
}

export type ToolInvocation = { input: unknown; signal: AbortSignal; idempotencyKey: string }

export abstract class ToolDefinition {
  abstract readonly name: string
  abstract readonly description: string
  abstract readonly effect: EToolEffect
  abstract readonly inputSchema: ZodType
  abstract readonly pathFields?: readonly DeclaredPathField[]

  abstract invoke(args: ToolInvocation): Promise<ToolOutcome>
}
