import {
  EBlockKind,
  readPartialJson,
  type CallId,
  type Chunk,
  type Event,
  type EventRef,
} from '@dltech/atlas-core'
import { EStepEnd, type StepId, type StepSignal } from '@dltech/atlas-harness'

import type { LiveToolCall } from './tool-runs'

export type StepBlock = { id: string; kind: EBlockKind; text: string }

export const runKey = (args: { stepId: StepId; kind: EBlockKind; id: string }): string =>
  `${args.stepId}:${args.kind}:${args.id}`

type ArrivingCall = LiveToolCall & {
  arriving: string | null
  parsed?: { source: string; input: unknown }
}

export type ArrivingStep = Omit<InFlightStep, 'calls'> & { calls: ArrivingCall[] }

export type InFlightStep = {
  stepId: StepId
  blocks: StepBlock[]
  calls: LiveToolCall[]
  end: EStepEnd | null
  supersededBy: EventRef | null
  errorMessage: string | null
}

export const emptyStep = (stepId: StepId): ArrivingStep => ({
  stepId,
  blocks: [],
  calls: [],
  end: null,
  supersededBy: null,
  errorMessage: null,
})

function blockFor(args: { step: ArrivingStep; kind: EBlockKind; id: string }): StepBlock {
  const existing = args.step.blocks.find((block) => block.kind === args.kind && block.id === args.id)
  if (existing !== undefined) return existing

  const created: StepBlock = { id: args.id, kind: args.kind, text: '' }
  args.step.blocks.push(created)
  return created
}

function openedCall(args: { step: ArrivingStep; callId: CallId; name: string }): ArrivingCall {
  const existing = args.step.calls.find((call) => call.callId === args.callId)
  if (existing !== undefined) return existing

  const opened: ArrivingCall = {
    callId: args.callId,
    name: args.name,
    input: undefined,
    precededByBlocks: args.step.blocks.length,
    arriving: null,
  }
  args.step.calls.push(opened)
  return opened
}

export function absorbChunk(args: { step: ArrivingStep; chunk: Chunk }) {
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
    case 'tool-input-start':
      openedCall({ step, callId: chunk.callId, name: chunk.name })
      return
    case 'tool-input-delta': {
      const call = step.calls.find((open) => open.callId === chunk.callId)
      if (call === undefined) return
      call.arriving = (call.arriving ?? '') + chunk.text
      return
    }
    case 'tool-call': {
      const call = openedCall({ step, callId: chunk.callId, name: chunk.name })
      call.input = chunk.input
      call.arriving = null
      return
    }
    default:
      return
  }
}

const parsedInputOf = (call: ArrivingCall): unknown => {
  const arriving = call.arriving
  if (arriving === null) return call.input

  if (call.parsed !== undefined && call.parsed.source === arriving) return call.parsed.input

  const input = readPartialJson(arriving)
  call.parsed = { source: arriving, input }
  return input
}

const settledCall = (call: ArrivingCall): LiveToolCall => ({
  callId: call.callId,
  name: call.name,
  input: parsedInputOf(call),
  precededByBlocks: call.precededByBlocks,
})

export const settledStep = (step: ArrivingStep): InFlightStep => ({
  ...step,
  calls: step.calls.map(settledCall),
})

function isSuperseded(args: {
  step: Pick<InFlightStep, 'end' | 'supersededBy'>
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

export function withoutFailedTail(args: {
  signals: readonly StepSignal[]
  events: readonly Event[]
}): readonly StepSignal[] {
  const live = liveSteps({ steps: stepsOfSignals(args.signals), events: args.events })
  const tail = live.at(-1)
  if (tail === undefined || tail.end !== EStepEnd.Failed) return args.signals

  return args.signals.filter((signal) => signal.stepId !== tail.stepId)
}

export function prunedSignals(args: {
  signals: readonly StepSignal[]
  events: readonly Event[]
}): readonly StepSignal[] {
  const live = liveSteps({ steps: stepsOfSignals(args.signals), events: args.events })
  const rendered = new Set(live.map((step) => step.stepId))
  const kept = args.signals.filter((signal) => rendered.has(signal.stepId))

  return kept.length === args.signals.length ? args.signals : kept
}

export function stepsOfSignals(signals: readonly StepSignal[]): InFlightStep[] {
  const ordered: ArrivingStep[] = []
  const byId = new Map<StepId, ArrivingStep>()

  const stepFor = (stepId: StepId): ArrivingStep => {
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

  return ordered.map(settledStep)
}
