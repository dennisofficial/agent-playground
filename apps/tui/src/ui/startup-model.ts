export enum EStartupPhase {
  Inking = 'inking',
  Holding = 'holding',
  Lifting = 'lifting',
  Gone = 'gone',
}

export const INK_MS = 520

export const SETTLE_MS = 160

export const LIFT_MS = 260

const DRAIN_SHARE = 0.45

const BREATH_MS = 2200

const BREATH_DEPTH = 0.14

export type StartupFrame = {
  phase: EStartupPhase
  reveal: number
  drain: number
  lift: number
}

const clamp = (value: number): number => Math.min(1, Math.max(0, value))

const eased = (value: number): number => 1 - (1 - value) * (1 - value)

const breathAt = (heldMs: number): number =>
  (BREATH_DEPTH * (1 - Math.cos((2 * Math.PI * heldMs) / BREATH_MS))) / 2

export function liftStartMs(args: {
  readyAtMs: number | null
  skippedAtMs: number | null
}): number | null {
  if (args.skippedAtMs !== null) return args.skippedAtMs
  if (args.readyAtMs === null) return null
  return Math.max(INK_MS, args.readyAtMs + SETTLE_MS)
}

/**
 * The curtain is held until the harness is ready *and* the ink has finished laying down, so a boot
 * that beats the animation still reads as one deliberate beat rather than a flash.
 */
export function startupFrame(args: {
  elapsedMs: number
  readyAtMs: number | null
  skippedAtMs: number | null
}): StartupFrame {
  const reveal = eased(clamp(args.elapsedMs / INK_MS))
  const liftsAt = liftStartMs(args)

  if (liftsAt === null || args.elapsedMs < liftsAt) {
    if (reveal < 1) return { phase: EStartupPhase.Inking, reveal, drain: 0, lift: 0 }
    return {
      phase: EStartupPhase.Holding,
      reveal,
      drain: breathAt(args.elapsedMs - INK_MS),
      lift: 0,
    }
  }

  const through = clamp((args.elapsedMs - liftsAt) / LIFT_MS)
  if (through >= 1) return { phase: EStartupPhase.Gone, reveal, drain: 1, lift: 1 }

  return {
    phase: EStartupPhase.Lifting,
    reveal,
    drain: clamp(through / DRAIN_SHARE),
    lift: eased(clamp((through - DRAIN_SHARE) / (1 - DRAIN_SHARE))),
  }
}

export const startupIsOver = (frame: StartupFrame): boolean => frame.phase === EStartupPhase.Gone
