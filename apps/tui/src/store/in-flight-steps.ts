import type { Chunk, Event, EventRef } from '@dltech/atlas-core'
import { EStepEnd, type ChannelSignal, type StepId } from '@dltech/atlas-harness'

export enum EBlockKind {
  Text = 'text',
  Reasoning = 'reasoning',
}

export type StepBlock = { id: string; kind: EBlockKind; text: string }

export type InFlightStep = {
  stepId: StepId
  blocks: StepBlock[]
  end: EStepEnd | null
  supersededBy: EventRef | null
  errorMessage: string | null
}

const emptyStep = (stepId: StepId): InFlightStep => ({
  stepId,
  blocks: [],
  end: null,
  supersededBy: null,
  errorMessage: null,
})

function blockFor(args: { step: InFlightStep; kind: EBlockKind; id: string }): StepBlock {
  const existing = args.step.blocks.find((block) => block.kind === args.kind && block.id === args.id)
  if (existing !== undefined) return existing

  const created: StepBlock = { id: args.id, kind: args.kind, text: '' }
  args.step.blocks.push(created)
  return created
}

function absorbChunk(args: { step: InFlightStep; chunk: Chunk }) {
  const { step, chunk } = args

  switch (chunk.type) {
    case 'error':
      step.errorMessage = chunk.message
      return
    case 'text-start':
    case 'text-end':
      blockFor({ step, kind: EBlockKind.Text, id: chunk.id })
      return
    case 'reasoning-start':
    case 'reasoning-end':
      blockFor({ step, kind: EBlockKind.Reasoning, id: chunk.id })
      return
    case 'text-delta':
      blockFor({ step, kind: EBlockKind.Text, id: chunk.id }).text += chunk.text
      return
    case 'reasoning-delta':
      blockFor({ step, kind: EBlockKind.Reasoning, id: chunk.id }).text += chunk.text
      return
    default:
      return
  }
}

function isSuperseded(args: {
  step: InFlightStep
  events: readonly Event[]
  isTrailing: boolean
}): boolean {
  if (args.step.end === null) return false

  const ref = args.step.supersededBy
  if (ref !== null) return args.events.some((event) => event.id === ref.eventId)

  return args.step.end !== EStepEnd.Failed || !args.isTrailing
}

export function liveSteps(args: {
  steps: readonly InFlightStep[]
  events: readonly Event[]
}): InFlightStep[] {
  return args.steps.filter(
    (step, index) =>
      !isSuperseded({ step, events: args.events, isTrailing: index === args.steps.length - 1 }),
  )
}

export function prunedSignals(args: {
  signals: readonly ChannelSignal[]
  events: readonly Event[]
}): readonly ChannelSignal[] {
  const live = liveSteps({ steps: stepsOfSignals(args.signals), events: args.events })
  const rendered = new Set(live.map((step) => step.stepId))
  const kept = args.signals.filter((signal) => rendered.has(signal.stepId))

  return kept.length === args.signals.length ? args.signals : kept
}

export function stepsOfSignals(signals: readonly ChannelSignal[]): InFlightStep[] {
  const ordered: InFlightStep[] = []
  const byId = new Map<StepId, InFlightStep>()

  const stepFor = (stepId: StepId): InFlightStep => {
    const existing = byId.get(stepId)
    if (existing !== undefined) return existing

    const created = emptyStep(stepId)
    byId.set(stepId, created)
    ordered.push(created)
    return created
  }

  for (const signal of signals) {
    const step = stepFor(signal.stepId)

    if (signal.type === 'chunk') absorbChunk({ step, chunk: signal.chunk })

    if (signal.type === 'step-ended') {
      step.end = signal.end
      step.supersededBy = signal.supersededBy
    }
  }

  return ordered
}
