import { z } from 'zod'

import { EAgentStart } from '../agents/start'
import { EAgentStatus } from '../agents/status'
import type { ProviderOptions } from '../provider'
import { EKilledBy, EShellStatus } from '../shells/status'
import { ECompactionAnchor, EDecision, EMessageOrigin, EWorktreeExit, type EventBody } from './body'
import type { EventEnvelope } from './envelope'
import { threadIdSchema, callIdSchema, eventIdSchema, runIdSchema } from './ids'

export const eventEnvelopeSchema: z.ZodType<EventEnvelope> = z.object({
  id: eventIdSchema,
  seq: z.number().int().positive(),
  threadId: threadIdSchema,
  runId: runIdSchema,
  parentRunId: runIdSchema.optional(),
  depth: z.number().int().nonnegative(),
  at: z.string().min(1),
})

const providerOptionsSchema = z.custom<ProviderOptions>(
  (value) => typeof value === 'object' && value !== null && !Array.isArray(value),
)

const assistantPartSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text'),
    text: z.string(),
    providerOptions: providerOptionsSchema.optional(),
  }),
  z.object({
    type: z.literal('reasoning'),
    text: z.string(),
    providerOptions: providerOptionsSchema.optional(),
  }),
])

const toolResultPartSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text'),
    text: z.string(),
    providerOptions: providerOptionsSchema.optional(),
  }),
  z.object({
    type: z.literal('image'),
    data: z.string(),
    mediaType: z.string(),
    source: z.string().optional(),
    providerOptions: providerOptionsSchema.optional(),
  }),
])

const saidImageSchema = z.object({
  path: z.string(),
  mediaType: z.string(),
  data: z.string(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
})

export const eventBodySchema: z.ZodType<EventBody> = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('user-said'),
    text: z.string(),
    via: z.enum(EMessageOrigin).optional(),
    images: z.array(saidImageSchema).optional(),
  }),
  z.object({
    type: z.literal('assistant-said'),
    parts: z.array(assistantPartSchema),
    interrupted: z.boolean().optional(),
  }),
  // Zod 4 requires a z.unknown() key to be present, where Zod 3 inferred it optional. A tool call or
  // result whose input or output is undefined loses the key to JSON.stringify, so both must say .optional()
  // or the stored row stops decoding.
  z.object({
    type: z.literal('tool-called'),
    callId: callIdSchema,
    name: z.string(),
    input: z.unknown().optional(),
    ordinal: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('tool-result'),
    callId: callIdSchema,
    name: z.string(),
    output: z.unknown().optional(),
    modelText: z.string().optional(),
    modelParts: z.array(toolResultPartSchema).optional(),
    error: z.object({ message: z.string() }).optional(),
    interrupted: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('tool-denied'),
    callId: callIdSchema,
    name: z.string(),
    reason: z.string(),
    interrupted: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('approval-requested'),
    callId: callIdSchema,
    reason: z.string(),
  }),
  z.object({
    type: z.literal('approval-answered'),
    callId: callIdSchema,
    decision: z.enum(EDecision),
    editedInput: z.unknown().optional(),
  }),
  z.object({
    type: z.literal('context-loaded'),
    slot: z.string(),
    key: z.string(),
    content: z.string(),
    triggeredBy: z.string().optional(),
  }),
  z.object({ type: z.literal('nudge'), text: z.string(), lifetimeSteps: z.number().int().nonnegative() }),
  z.object({
    type: z.literal('worktree-entered'),
    path: z.string().min(1),
    branch: z.string().min(1),
    base: z.string().min(1),
  }),
  z.object({
    type: z.literal('worktree-exited'),
    path: z.string().min(1),
    action: z.enum(EWorktreeExit),
  }),
  z.object({
    type: z.literal('background-shell-ended'),
    shellId: z.string().min(1),
    command: z.string(),
    description: z.string().optional(),
    status: z.enum(EShellStatus),
    killedBy: z.enum(EKilledBy).optional(),
    exitCode: z.number().int().optional(),
    output: z.string(),
    droppedCharacters: z.number().int().nonnegative(),
    remainingCharacters: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('background-shell-awaiting-input'),
    shellId: z.string().min(1),
    command: z.string(),
    description: z.string().optional(),
    output: z.string(),
    droppedCharacters: z.number().int().nonnegative(),
    remainingCharacters: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('agent-spawned'),
    agentId: threadIdSchema,
    agentType: z.string().min(1),
    intent: z.string(),
    mode: z.enum(EAgentStart),
  }),
  z.object({
    type: z.literal('agent-ended'),
    agentId: threadIdSchema,
    agentType: z.string().min(1),
    intent: z.string(),
    status: z.enum(EAgentStatus),
    killedBy: z.enum(EKilledBy).optional(),
    prose: z.string(),
    turns: z.number().int().nonnegative(),
    toolCalls: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('history-compacted'),
    anchor: z.enum(ECompactionAnchor),
    fromSeq: z.number().int().positive(),
    throughSeq: z.number().int().positive(),
    summary: z.string(),
    replaced: z.number().int().nonnegative(),
  }),
])
