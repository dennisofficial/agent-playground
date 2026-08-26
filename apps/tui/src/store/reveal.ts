import type { Event } from '@dltech/atlas-core'
import type { ChannelSignal } from '@dltech/atlas-harness'

import { liveSteps, runKey, stepsOfSignals } from './in-flight-steps'

export const FRAME_MS = 33

const REVEAL_HORIZON_MS = 150

const REVEAL_MIN_CHARS = 3

const REVEAL_BURST_CAP = 600

export type RevealGate = { key: string; revealed: number }

export type TailRun = { key: string; text: string }

export function tailRunOf(args: {
  events: readonly Event[]
  signals: readonly ChannelSignal[]
}): TailRun | null {
  const step = liveSteps({ steps: stepsOfSignals(args.signals), events: args.events }).at(-1)
  if (step === undefined || step.end !== null) return null

  const block = step.blocks.at(-1)
  if (block === undefined) return null

  return { key: runKey({ stepId: step.stepId, kind: block.kind, id: block.id }), text: block.text }
}

export function attachedGate(args: { gate: RevealGate | null; tail: TailRun | null }): RevealGate | null {
  if (args.tail === null) return null
  if (args.gate?.key === args.tail.key) return args.gate

  return { key: args.tail.key, revealed: 0 }
}

export function advancedGate(args: { gate: RevealGate | null; tail: TailRun | null }): RevealGate | null {
  const attached = attachedGate(args)
  if (attached === null || args.tail === null) return null

  const backlog = args.tail.text.length - attached.revealed
  if (backlog <= 0) return attached

  const reached = attached.revealed + sliceSize(backlog)
  return { key: attached.key, revealed: pastAnyLoneSurrogate({ text: args.tail.text, at: reached }) }
}

export const gateIsDraining = (args: { gate: RevealGate | null; tail: TailRun | null }): boolean =>
  args.tail !== null && (args.gate?.key !== args.tail.key || args.gate.revealed < args.tail.text.length)

export function revealedText(args: { key: string; text: string; gate: RevealGate | null }): string {
  if (args.gate === null || args.gate.key !== args.key) return args.text
  return args.text.slice(0, args.gate.revealed)
}

/**
 * Proportional drain rather than a measured character rate, because a rate estimate is open-loop and
 * its error accumulates: guess low and the tail falls further behind every chunk, guess high and it
 * drains empty and stalls between them. Dividing the backlog makes arrival rate the input, so the
 * reveal tracks any speed and settles about one horizon behind the wire.
 */
function sliceSize(backlog: number): number {
  if (backlog > REVEAL_BURST_CAP) return backlog

  const frames = Math.max(1, Math.round(REVEAL_HORIZON_MS / FRAME_MS))
  return Math.min(backlog, Math.max(REVEAL_MIN_CHARS, Math.ceil(backlog / frames)))
}

function pastAnyLoneSurrogate(args: { text: string; at: number }): number {
  const code = args.text.charCodeAt(args.at - 1)
  const isHighSurrogate = code >= 0xd800 && code <= 0xdbff
  return isHighSurrogate && args.at < args.text.length ? args.at + 1 : args.at
}
