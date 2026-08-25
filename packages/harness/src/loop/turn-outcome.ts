import type { CallId, RunId } from '@dltech/atlas-core'

export enum ETurnStatus {
  Completed = 'completed',
  Paused = 'paused',
  Exhausted = 'exhausted',
  Idle = 'idle',
  Failed = 'failed',
}

export type TurnOutcome =
  | { status: ETurnStatus.Completed; runId: RunId }
  | { status: ETurnStatus.Paused; runId: RunId; callId: CallId; reason: string }
  | { status: ETurnStatus.Exhausted; runId: RunId }
  | { status: ETurnStatus.Idle; runId: RunId }
  | { status: ETurnStatus.Failed; runId: RunId; message: string; cause: unknown }
