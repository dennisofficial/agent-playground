import {
  stampDrafts,
  toBranchId,
  toEventId,
  toRunId,
  type Event,
  type EventDraft,
  type EventEnvelope,
  type EventRef,
} from '@dltech/atlas-core'
import { EStepEnd, toStepId, type StepId, type StepSignal } from '@dltech/atlas-harness'

import { EEntryKind, type TranscriptEntry, type TranscriptModel } from '../transcript-model'

export const fixtureBranchId = toBranchId('branch-fixture')

const fixtureRunId = toRunId('run-fixture')

const envelopeAt = (index: number): EventEnvelope => ({
  id: toEventId(`event-${index + 1}`),
  seq: index + 1,
  branchId: fixtureBranchId,
  runId: fixtureRunId,
  depth: 0,
  at: '2026-01-01T00:00:00.000Z',
})

export function log(drafts: readonly EventDraft[]): Event[] {
  return stampDrafts({ drafts, envelopes: drafts.map((_draft, index) => envelopeAt(index)) })
}

export const refTo = (event: Event): EventRef => ({ eventId: event.id, seq: event.seq })

export const stepOne: StepId = toStepId('step-1')
export const stepTwo: StepId = toStepId('step-2')

export const started = (stepId: StepId): StepSignal => ({ type: 'step-started', stepId })

export const textDelta = (args: { stepId: StepId; blockId: string; text: string }): StepSignal => ({
  type: 'chunk',
  stepId: args.stepId,
  chunk: { type: 'text-delta', id: args.blockId, text: args.text },
})

export const reasoningDelta = (args: { stepId: StepId; blockId: string; text: string }): StepSignal => ({
  type: 'chunk',
  stepId: args.stepId,
  chunk: { type: 'reasoning-delta', id: args.blockId, text: args.text },
})

export const ended = (args: {
  stepId: StepId
  end: EStepEnd
  supersededBy: EventRef | null
}): StepSignal => ({
  type: 'step-ended',
  stepId: args.stepId,
  end: args.end,
  supersededBy: args.supersededBy,
})

export const fromTheModel = (model: TranscriptModel) =>
  model.entries.filter(
    (
      entry,
    ): entry is Exclude<
      TranscriptEntry,
      | { kind: EEntryKind.OperatorSaid }
      | { kind: EEntryKind.HistoryCompacted }
      | { kind: EEntryKind.BackgroundShellEnded }
    > =>
      entry.kind !== EEntryKind.OperatorSaid &&
      entry.kind !== EEntryKind.HistoryCompacted &&
      entry.kind !== EEntryKind.BackgroundShellEnded,
  )

export const fromTheOperator = (model: TranscriptModel) =>
  model.entries.filter(
    (entry): entry is Extract<TranscriptEntry, { kind: EEntryKind.OperatorSaid }> =>
      entry.kind === EEntryKind.OperatorSaid,
  )
