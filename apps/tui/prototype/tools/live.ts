// PROTOTYPE — throwaway. A run that is still happening.
//
// The streaming window and the height ratchet only exist while a turn runs, and a store full of
// settled events cannot show that — so the busiest real run in the thread is replayed on a clock:
// calls settle one at a time, the one in flight reveals its output a few lines at a time, and the
// whole thing loops. Real commands, real output; only the timing is invented.

import { ECallState, type ToolCall, type ToolRun } from '../../src/store'

const CALL_MS = 1_600

const REVEAL_MS = 220

const HOLD_CALLS = 1

const running = (call: ToolCall, lines: readonly string[]): ToolCall => ({
  ...call,
  state: ECallState.Pending,
  settledAt: null,
  modelText: lines.join('\n'),
})

export function liveRunAt(args: { script: ToolRun | null; now: number }): ToolRun | null {
  const script = args.script
  if (script === null || script.calls.length === 0) return null

  const span = script.calls.length + HOLD_CALLS
  const tick = Math.floor(args.now / CALL_MS) % span
  const done = script.calls.slice(0, tick)
  const inFlight = script.calls[tick]
  if (inFlight === undefined) return script

  const shown = Math.floor((args.now % CALL_MS) / REVEAL_MS)
  const printed = inFlight.modelText.length === 0 ? [] : inFlight.modelText.split('\n')

  return { ...script, calls: [...done, running(inFlight, printed.slice(0, shown))] }
}

/** The busiest real run in the thread — the one worth watching happen. */
export function busiestRun(runs: readonly ToolRun[]): ToolRun | null {
  let best: ToolRun | null = null
  for (const run of runs) if (run.calls.length > (best?.calls.length ?? 0)) best = run
  return best
}
