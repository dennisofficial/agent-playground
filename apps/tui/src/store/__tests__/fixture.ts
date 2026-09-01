import {
  stampDrafts,
  toCallId,
  toThreadId,
  toEventId,
  toRunId,
  type Event,
  type EventDraft,
  type EventEnvelope,
  type EventRef,
} from '@dltech/atlas-core'
import { EStepEnd, toStepId, type StepId, type StepSignal } from '@dltech/atlas-harness'

import { EEntryKind, type TranscriptEntry, type TranscriptModel } from '../transcript-model'

export const fixtureThreadId = toThreadId('thread-fixture')

const fixtureRunId = toRunId('run-fixture')

const envelopeAt = (index: number): EventEnvelope => ({
  id: toEventId(`event-${index + 1}`),
  seq: index + 1,
  threadId: fixtureThreadId,
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

export const toolInputStart = (args: { stepId: StepId; callId: string; name: string }): StepSignal => ({
  type: 'chunk',
  stepId: args.stepId,
  chunk: { type: 'tool-input-start', callId: toCallId(args.callId), name: args.name },
})

export const toolInputDelta = (args: { stepId: StepId; callId: string; text: string }): StepSignal => ({
  type: 'chunk',
  stepId: args.stepId,
  chunk: { type: 'tool-input-delta', callId: toCallId(args.callId), text: args.text },
})

export const toolInputEnd = (args: { stepId: StepId; callId: string }): StepSignal => ({
  type: 'chunk',
  stepId: args.stepId,
  chunk: { type: 'tool-input-end', callId: toCallId(args.callId) },
})

export const toolCall = (args: {
  stepId: StepId
  callId: string
  name: string
  input: unknown
}): StepSignal => ({
  type: 'chunk',
  stepId: args.stepId,
  chunk: { type: 'tool-call', callId: toCallId(args.callId), name: args.name, input: args.input },
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
      | { kind: EEntryKind.BackgroundShellAwaitingInput }
      | { kind: EEntryKind.AgentEnded }
      | { kind: EEntryKind.TurnEnded }
    > =>
      entry.kind !== EEntryKind.OperatorSaid &&
      entry.kind !== EEntryKind.HistoryCompacted &&
      entry.kind !== EEntryKind.BackgroundShellEnded &&
      entry.kind !== EEntryKind.BackgroundShellAwaitingInput &&
      entry.kind !== EEntryKind.AgentEnded &&
      entry.kind !== EEntryKind.TurnEnded,
  )

export const fromTheOperator = (model: TranscriptModel) =>
  model.entries.filter(
    (entry): entry is Extract<TranscriptEntry, { kind: EEntryKind.OperatorSaid }> =>
      entry.kind === EEntryKind.OperatorSaid,
  )
