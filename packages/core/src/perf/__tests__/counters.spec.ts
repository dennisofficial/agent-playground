import { describe, expect, it } from 'bun:test'

import {
  addPerfCounter,
  adjustPerfGauge,
  drainPerfCounters,
  measurePerf,
  readPerfGauge,
  readPerfGauges,
  resetPerfTelemetry,
  setPerfGauge,
} from '../counters'
import { EPerfCounter, EPerfGauge, modelChunkKey, EPerfModelRole } from '../keys'

describe('perf counters', () => {
  it('accumulates deltas and drains them once', () => {
    resetPerfTelemetry()
    addPerfCounter({ key: EPerfCounter.ChannelChunk })
    addPerfCounter({ key: EPerfCounter.ChannelChunk, delta: 4 })

    expect(drainPerfCounters()).toEqual({ [EPerfCounter.ChannelChunk]: 5 })
    expect(drainPerfCounters()).toEqual({})
  })

  it('times a measured block into a duration counter', () => {
    resetPerfTelemetry()
    const answer = measurePerf({ key: EPerfCounter.RepublishMs, run: () => 42 })

    expect(answer).toBe(42)
    const drained = drainPerfCounters()
    expect(drained[EPerfCounter.RepublishMs]).toBeGreaterThanOrEqual(0)
  })

  it('tracks gauges as levels rather than deltas', () => {
    resetPerfTelemetry()
    adjustPerfGauge({ key: EPerfGauge.TurnDepth, delta: 1 })
    adjustPerfGauge({ key: EPerfGauge.TurnDepth, delta: 1 })
    expect(readPerfGauge({ key: EPerfGauge.TurnDepth })).toBe(2)
    expect(readPerfGauges()).toEqual({ [EPerfGauge.TurnDepth]: 2 })

    setPerfGauge({ key: EPerfGauge.TurnDepth, value: 0 })
    expect(readPerfGauge({ key: EPerfGauge.TurnDepth })).toBe(0)

    drainPerfCounters()
    expect(readPerfGauge({ key: EPerfGauge.TurnDepth })).toBe(0)
  })

  it('keeps model-role keys under the typed template', () => {
    expect(modelChunkKey(EPerfModelRole.Tldr)).toBe('modelChunk:tldr')
  })
})
