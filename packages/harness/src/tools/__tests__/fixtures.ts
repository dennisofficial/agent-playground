import { z } from 'zod'

import {
  EToolEffect,
  toCallId,
  toRunId,
  toThreadId,
  type ToolDefinition,
  type ToolInvocation,
  type ToolOutcome,
} from '@dltech/atlas-core'

import type { DispatchableCall } from '../dispatch'

export const readCall: DispatchableCall = {
  callId: toCallId('call-1'),
  name: 'read',
  input: { path: 'a.ts' },
  runId: toRunId('run-1'),
  threadId: toThreadId('thread-1'),
}

export function toolNamed(args: {
  name: string
  effect?: EToolEffect
  invoke: (invocation: ToolInvocation) => Promise<ToolOutcome>
}): ToolDefinition {
  return {
    name: args.name,
    description: `the ${args.name} tool`,
    effect: args.effect ?? EToolEffect.Read,
    inputSchema: z.object({ path: z.string() }),
    invoke: args.invoke,
  }
}
