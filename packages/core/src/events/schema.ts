import { z } from 'zod'

import type { ProviderOptions } from '../provider'
import { EDecision, type EventBody } from './body'
import type { EventEnvelope } from './envelope'
import { branchIdSchema, callIdSchema, eventIdSchema, runIdSchema, snapshotIdSchema } from './ids'

export const eventEnvelopeSchema: z.ZodType<EventEnvelope> = z.object({
  id: eventIdSchema,
  seq: z.number().int().positive(),
  branchId: branchIdSchema,
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

export const eventBodySchema: z.ZodType<EventBody> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('user-said'), text: z.string() }),
  z.object({
    type: z.literal('assistant-said'),
    parts: z.array(assistantPartSchema),
    interrupted: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('tool-called'),
    callId: callIdSchema,
    name: z.string(),
    input: z.unknown(),
    ordinal: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('tool-result'),
    callId: callIdSchema,
    name: z.string(),
    output: z.unknown(),
    modelText: z.string().optional(),
    error: z.object({ message: z.string() }).optional(),
    snapshotId: snapshotIdSchema.optional(),
  }),
  z.object({
    type: z.literal('tool-denied'),
    callId: callIdSchema,
    name: z.string(),
    reason: z.string(),
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
])
