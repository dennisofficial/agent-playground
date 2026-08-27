import type { CallId, RunId } from '@dltech/atlas-core'

export enum ETurnStatus {
  Completed = 'completed',
  Paused = 'paused',
  Idle = 'idle',
  Interrupted = 'interrupted',
  Failed = 'failed',
}

export type TurnOutcome =
  | { status: ETurnStatus.Completed; runId: RunId }
  | { status: ETurnStatus.Paused; runId: RunId; callId: CallId; reason: string }
  | { status: ETurnStatus.Idle; runId: RunId }
  | { status: ETurnStatus.Interrupted; runId: RunId; committed: boolean }
  | { status: ETurnStatus.Failed; runId: RunId; message: string; cause: unknown }
