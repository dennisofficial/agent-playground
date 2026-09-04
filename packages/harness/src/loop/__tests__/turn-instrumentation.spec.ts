import { afterEach, describe, expect, it } from 'bun:test'

import {
  drainPerfCounters,
  EPerfCounter,
  EPerfGauge,
  readPerfGauge,
  resetPerfTelemetry,
} from '@dltech/atlas-core'

import { buildHarness, ETurnStatus, type AtlasHarness } from '..'
import { scriptedModel } from '../../model/testing/scripted-model'
import { createTempDatabase, type TempDatabase } from './temp-database'

const opened: { harness: AtlasHarness; temp: TempDatabase }[] = []

afterEach(async () => {
  for (const entry of opened.splice(0)) {
    await entry.harness.close()
    entry.temp.discard()
  }
  resetPerfTelemetry()
})

describe('turn instrumentation', () => {
  it('counts the phases of a turn and returns the gauge to zero', async () => {
    const temp = createTempDatabase()
    const harness = await buildHarness({
      databaseUrl: temp.databaseUrl,
      model: scriptedModel({ script: [{ text: 'hello' }] }),
    })
    opened.push({ harness, temp })

    const thread = await harness.threads.create({})
    const outcome = await harness.runner.say({ threadId: thread.id, text: 'hi' })
    expect(outcome.status).toBe(ETurnStatus.Completed)

    const counters = drainPerfCounters()
    expect(counters[EPerfCounter.TurnMs]).toBeGreaterThan(0)
    expect(counters[EPerfCounter.TurnModelStepMs]).toBeGreaterThan(0)
    expect(counters[EPerfCounter.HarnessChunk]).toBeGreaterThan(0)
    expect(counters[EPerfCounter.TurnLogReadMs]).toBeGreaterThan(0)

    expect(readPerfGauge({ key: EPerfGauge.HarnessTurnDepth })).toBe(0)
  })
})
