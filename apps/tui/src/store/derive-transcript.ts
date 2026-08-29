import { EBlockKind, type Event } from '@dltech/atlas-core'
import { EStepEnd, type StepSignal, type TurnSpend } from '@dltech/atlas-harness'

import { durableEntries } from './durable-entries'
import { liveSteps, runKey, stepsOfSignals, type InFlightStep } from './in-flight-steps'
import { revealedText, type RevealGate } from './reveal'
import { modelEntries } from './model-entries'
import { liveToolGroups, type LiveToolGroup } from './tool-groups'
import {
  foldThoughts,
  SHIPPED_THINKING,
  toolsAboveThoughts,
  type EThinkingVisibility,
} from './thinking-fold'
import {
  EMPTY_TRANSCRIPT,
  toolsRanEntry,
  type StepFailure,
  type TranscriptEntry,
  type TranscriptModel,
} from './transcript-model'

const failureOf = (steps: readonly InFlightStep[]): StepFailure | null => {
  const failed = steps.filter((step) => step.end === EStepEnd.Failed).at(-1)
  return failed === undefined ? null : { message: failed.errorMessage }
}

function saidInStep(args: { step: InFlightStep; reveal: RevealGate | null }): TranscriptEntry[] {
  return modelEntries({
    runs: args.step.blocks.map((block) => {
      const key = runKey({ stepId: args.step.stepId, kind: block.kind, id: block.id })
      return {
        key,
        text: revealedText({ key, text: block.text, gate: args.reveal }),
        isReasoning: block.kind === EBlockKind.Reasoning,
      }
    }),
    streaming: args.step.end === null,
    interruptedAtEnd: args.step.end === EStepEnd.Interrupted,
  })
}

function interleaved(args: {
  said: readonly TranscriptEntry[]
  groups: readonly LiveToolGroup[]
}): TranscriptEntry[] {
  const entries: TranscriptEntry[] = []
  let cursor = 0

  for (const { group, precededByBlocks } of args.groups) {
    const upTo = Math.max(cursor, Math.min(precededByBlocks, args.said.length))
    entries.push(...args.said.slice(cursor, upTo), toolsRanEntry(group))
    cursor = upTo
  }

  entries.push(...args.said.slice(cursor))
  return entries
}

function entriesOfStep(args: { step: InFlightStep; reveal: RevealGate | null }): TranscriptEntry[] {
  return interleaved({
    said: saidInStep(args),
    groups: liveToolGroups(args.step.calls),
  })
}

export function deriveTranscript(args: {
  events: readonly Event[]
  signals: readonly StepSignal[]
  turns?: readonly TurnSpend[] | undefined
  reveal?: RevealGate | null
  thinking?: EThinkingVisibility
}): TranscriptModel {
  const reveal = args.reveal ?? null
  const live = liveSteps({ steps: stepsOfSignals(args.signals), events: args.events })
  const entries = foldThoughts({
    entries: toolsAboveThoughts([
      ...durableEntries({ events: args.events, turns: args.turns }),
      ...live.flatMap((step) => entriesOfStep({ step, reveal })),
    ]),
    visibility: args.thinking ?? SHIPPED_THINKING,
  })
  const streaming = live.some((step) => step.end === null)
  const failure = failureOf(live)

  if (entries.length === 0 && !streaming && failure === null) return EMPTY_TRANSCRIPT

  return { entries, isEmpty: entries.length === 0, streaming, failure }
}
