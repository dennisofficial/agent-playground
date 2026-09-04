import type { PerfCounterKey } from './keys'
import type { EPerfGauge } from './keys'

/**
 * Process-local telemetry counters, shared between the TUI (which knows what it rendered) and the
 * harness sampler (which knows the process stats) without either depending on the other. Counter
 * deltas are drained per sample window; gauges hold a current level such as turns in flight.
 */
const counters = new Map<string, number>()
const gauges = new Map<string, number>()

export function addPerfCounter(args: { key: PerfCounterKey; delta?: number }): void {
  counters.set(args.key, (counters.get(args.key) ?? 0) + (args.delta ?? 1))
}

export function measurePerf<TResult>(args: { key: PerfCounterKey; run: () => TResult }): TResult {
  const started = performance.now()
  try {
    return args.run()
  } finally {
    addPerfCounter({ key: args.key, delta: performance.now() - started })
  }
}

export async function measurePerfAsync<TResult>(args: {
  key: PerfCounterKey
  run: () => Promise<TResult>
}): Promise<TResult> {
  const started = performance.now()
  try {
    return await args.run()
  } finally {
    addPerfCounter({ key: args.key, delta: performance.now() - started })
  }
}

export function setPerfGauge(args: { key: EPerfGauge; value: number }): void {
  gauges.set(args.key, args.value)
}

export function adjustPerfGauge(args: { key: EPerfGauge; delta: number }): void {
  setPerfGauge({ key: args.key, value: readPerfGauge({ key: args.key }) + args.delta })
}

export function readPerfGauge(args: { key: EPerfGauge }): number {
  return gauges.get(args.key) ?? 0
}

export function readPerfGauges(): Record<string, number> {
  return Object.fromEntries(gauges)
}

export function drainPerfCounters(): Record<string, number> {
  const drained: Record<string, number> = {}
  for (const [key, value] of counters) drained[key] = value
  counters.clear()
  return drained
}

export function resetPerfTelemetry(): void {
  counters.clear()
  gauges.clear()
}
