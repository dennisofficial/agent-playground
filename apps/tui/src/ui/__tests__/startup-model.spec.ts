import { describe, expect, it } from 'bun:test'

import {
  EStartupPhase,
  INK_MS,
  LIFT_MS,
  SETTLE_MS,
  startupFrame,
  startupIsOver,
} from '../startup-model'

const frameAt = (args: {
  elapsedMs: number
  readyAtMs?: number | null
  skippedAtMs?: number | null
}) =>
  startupFrame({
    elapsedMs: args.elapsedMs,
    readyAtMs: args.readyAtMs ?? null,
    skippedAtMs: args.skippedAtMs ?? null,
  })

describe('startupFrame', () => {
  it('lays the ink down from nothing', () => {
    const frame = frameAt({ elapsedMs: 0 })
    expect(frame.phase).toBe(EStartupPhase.Inking)
    expect(frame.reveal).toBe(0)
    expect(frame.lift).toBe(0)
  })

  it('lays it down monotonically', () => {
    let last = -1
    for (let at = 0; at <= INK_MS; at += 20) {
      const { reveal } = frameAt({ elapsedMs: at })
      expect(reveal).toBeGreaterThanOrEqual(last)
      last = reveal
    }
    expect(last).toBe(1)
  })

  it('holds forever while the harness is still starting', () => {
    const frame = frameAt({ elapsedMs: INK_MS * 20 })
    expect(frame.phase).toBe(EStartupPhase.Holding)
    expect(frame.reveal).toBe(1)
    expect(frame.lift).toBe(0)
  })

  it('breathes while it holds, so a slow boot does not read as a hung one', () => {
    const drains = [0, 400, 800, 1200].map((at) => frameAt({ elapsedMs: INK_MS + at }).drain)
    expect(new Set(drains).size).toBeGreaterThan(1)
    for (const drain of drains) expect(drain).toBeLessThan(0.2)
  })

  it('will not lift before the ink has finished, however fast the harness was', () => {
    const frame = frameAt({ elapsedMs: INK_MS / 2, readyAtMs: 10 })
    expect(frame.phase).toBe(EStartupPhase.Inking)
    expect(frame.lift).toBe(0)
  })

  it('gives the workspace a beat to settle once the harness is ready', () => {
    const readyAtMs = INK_MS * 3
    expect(frameAt({ elapsedMs: readyAtMs + SETTLE_MS - 1, readyAtMs }).phase).toBe(
      EStartupPhase.Holding,
    )
    expect(frameAt({ elapsedMs: readyAtMs + SETTLE_MS + 1, readyAtMs }).phase).toBe(
      EStartupPhase.Lifting,
    )
  })

  it('drains the ink before it retracts, so nothing is cut in half on the way out', () => {
    const readyAtMs = 0
    const liftsAt = INK_MS
    const early = frameAt({ elapsedMs: liftsAt + LIFT_MS * 0.2, readyAtMs })

    expect(early.drain).toBeGreaterThan(0)
    expect(early.lift).toBe(0)

    const late = frameAt({ elapsedMs: liftsAt + LIFT_MS * 0.9, readyAtMs })
    expect(late.drain).toBe(1)
    expect(late.lift).toBeGreaterThan(0)
  })

  it('is over once the lift has run its course', () => {
    const frame = frameAt({ elapsedMs: INK_MS + LIFT_MS, readyAtMs: 0 })
    expect(frame.phase).toBe(EStartupPhase.Gone)
    expect(frame.lift).toBe(1)
    expect(startupIsOver(frame)).toBe(true)
  })

  it('lifts from wherever a keypress asked it to, ink or not', () => {
    const skippedAtMs = 120
    expect(frameAt({ elapsedMs: skippedAtMs + 1, skippedAtMs }).phase).toBe(EStartupPhase.Lifting)
    expect(startupIsOver(frameAt({ elapsedMs: skippedAtMs + LIFT_MS, skippedAtMs }))).toBe(true)
  })

  it('lets a keypress overtake a settle the operator did not ask to wait for', () => {
    const readyAtMs = INK_MS * 4
    const skippedAtMs = readyAtMs + 10
    expect(frameAt({ elapsedMs: skippedAtMs + 1, readyAtMs, skippedAtMs }).phase).toBe(
      EStartupPhase.Lifting,
    )
  })
})
