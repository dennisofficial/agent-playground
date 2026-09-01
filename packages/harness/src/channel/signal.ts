import { z } from 'zod'

import type { Chunk, ERetryReason, EventRef } from '@dltech/atlas-core'

export const stepIdSchema = z.string().min(1).brand<'StepId'>()

export type StepId = z.infer<typeof stepIdSchema>

export const toStepId = (value: string): StepId => stepIdSchema.parse(value)

export enum EStepEnd {
  Completed = 'completed',
  Interrupted = 'interrupted',
  Failed = 'failed',
  Retried = 'retried',
}

export type StepSignal =
  | { type: 'step-started'; stepId: StepId }
  | { type: 'chunk'; stepId: StepId; chunk: Chunk }
  | { type: 'step-ended'; stepId: StepId; end: EStepEnd; supersededBy: EventRef | null }

export type RetryWaitingSignal = {
  type: 'retry-waiting'
  attempt: number
  maxAttempts: number
  delayMs: number
  reason: ERetryReason
}

export type ChannelSignal =
  | StepSignal
  | { type: 'events-appended' }
  | RetryWaitingSignal
  | { type: 'retry-cleared' }
