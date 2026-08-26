import type { ZodType } from 'zod'

import type { CallId } from '../events/ids'

export enum EToolEffect {
  Read = 'read',
  Write = 'write',
  Destructive = 'destructive',
}

export type ToolCall = { callId: CallId; name: string; input: unknown; effect: EToolEffect }

export type ToolOutcome =
  | { ok: true; output: unknown; modelText: string }
  | { ok: false; reason: string }

export type ToolDeclaration = {
  name: string
  description: string
  effect: EToolEffect
  inputSchema: ZodType
}

export type ToolInvocation = { input: unknown; signal: AbortSignal; idempotencyKey: string }

export type ToolDefinition = ToolDeclaration & {
  invoke(args: ToolInvocation): Promise<ToolOutcome>
}
