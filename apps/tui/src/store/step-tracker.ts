import type { Event } from '@dltech/atlas-core'
import { EStepEnd, type StepId, type StepSignal } from '@dltech/atlas-harness'

import {
  absorbChunk,
  emptyStep,
  liveSteps,
  runKey,
  settledStep,
  type ArrivingStep,
  type InFlightStep,
} from './in-flight-steps'
import type { TailRun } from './reveal'

export type StepTracker = {
  absorb(signal: StepSignal): void
  live(events: readonly Event[]): InFlightStep[]
  tailRun(events: readonly Event[]): TailRun | null
  pruneSuperseded(events: readonly Event[]): boolean
  dropFailedTail(events: readonly Event[]): boolean
}

export function createStepTracker(): StepTracker {
  let ordered: ArrivingStep[] = []
  const byId = new Map<StepId, ArrivingStep>()
  let settled: InFlightStep[] | null = null

  const stepFor = (stepId: StepId): ArrivingStep => {
    const existing = byId.get(stepId)
    if (existing !== undefined) return existing

    const created = emptyStep(stepId)
    byId.set(stepId, created)
    ordered.push(created)
    return created
  }

  const snapshot = (): InFlightStep[] => {
    settled ??= ordered.map(settledStep)
    return settled
  }

  const liveNow = (events: readonly Event[]): InFlightStep[] =>
    liveSteps({ steps: snapshot(), events })

  const forget = (stepId: StepId) => {
    byId.delete(stepId)
    ordered = ordered.filter((step) => step.stepId !== stepId)
    settled = null
  }

  return {
    absorb(signal) {
      const step = stepFor(signal.stepId)

      if (signal.type === 'chunk') absorbChunk({ step, chunk: signal.chunk })

      if (signal.type === 'step-ended') {
        step.end = signal.end
        step.supersededBy = signal.supersededBy
      }

      settled = null
    },

    live(events) {
      return liveNow(events)
    },

    tailRun(events) {
      const step = liveNow(events).at(-1)
      if (step === undefined || step.end !== null) return null

      const block = step.blocks.at(-1)
      if (block === undefined) return null

      return {
        key: runKey({ stepId: step.stepId, kind: block.kind, id: block.id }),
        text: block.text,
      }
    },

    pruneSuperseded(events) {
      const kept = new Set(liveNow(events).map((step) => step.stepId))
      if (kept.size === ordered.length) return false

      for (const step of [...ordered]) {
        if (!kept.has(step.stepId)) forget(step.stepId)
      }
      return true
    },

    dropFailedTail(events) {
      const tail = liveNow(events).at(-1)
      if (tail === undefined || tail.end !== EStepEnd.Failed) return false

      forget(tail.stepId)
      return true
    },
  }
}
