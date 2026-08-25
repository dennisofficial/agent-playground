import type { Event } from '@dltech/atlas-core'
import { EStepEnd, type ChannelSignal } from '@dltech/atlas-harness'

import { durableEntries } from './durable-entries'
import { EBlockKind, liveSteps, stepsOfSignals, type InFlightStep } from './in-flight-steps'
import {
  EAuthor,
  EEntryKind,
  EMPTY_TRANSCRIPT,
  type StepFailure,
  type TranscriptEntry,
  type TranscriptModel,
} from './transcript-model'

const failureOf = (steps: readonly InFlightStep[]): StepFailure | null => {
  const failed = steps.filter((step) => step.end === EStepEnd.Failed).at(-1)
  return failed === undefined ? null : { message: failed.errorMessage }
}

function entriesOfStep(step: InFlightStep): TranscriptEntry[] {
  return step.blocks.map((block, index) => {
    const shared = {
      author: EAuthor.Model,
      key: `${step.stepId}:${block.kind}:${block.id}`,
      text: block.text,
      streaming: step.end === null,
      interrupted: step.end === EStepEnd.Interrupted && index === step.blocks.length - 1,
    } as const

    return block.kind === EBlockKind.Reasoning
      ? { kind: EEntryKind.ModelThought, ...shared }
      : { kind: EEntryKind.ModelSaid, ...shared }
  })
}

export function deriveTranscript(args: {
  events: readonly Event[]
  signals: readonly ChannelSignal[]
}): TranscriptModel {
  const live = liveSteps({ steps: stepsOfSignals(args.signals), events: args.events })
  const entries = [...durableEntries(args.events), ...live.flatMap(entriesOfStep)]
  const streaming = live.some((step) => step.end === null)
  const failure = failureOf(live)

  if (entries.length === 0 && !streaming && failure === null) return EMPTY_TRANSCRIPT

  return { entries, isEmpty: entries.length === 0, streaming, failure }
}
