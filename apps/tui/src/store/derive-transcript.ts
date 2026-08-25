import { EBlockKind, type Event } from '@dltech/atlas-core'
import { EStepEnd, type ChannelSignal } from '@dltech/atlas-harness'

import { durableEntries } from './durable-entries'
import { liveSteps, stepsOfSignals, type InFlightStep } from './in-flight-steps'
import { modelEntries } from './model-entries'
import {
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
  return modelEntries({
    runs: step.blocks.map((block) => ({
      key: `${step.stepId}:${block.kind}:${block.id}`,
      text: block.text,
      isReasoning: block.kind === EBlockKind.Reasoning,
    })),
    streaming: step.end === null,
    interruptedAtEnd: step.end === EStepEnd.Interrupted,
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
