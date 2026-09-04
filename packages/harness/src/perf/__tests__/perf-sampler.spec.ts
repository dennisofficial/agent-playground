import { describe, expect, it } from 'bun:test'

import {
  addPerfCounter,
  adjustPerfGauge,
  EPerfCounter,
  EPerfGauge,
  resetPerfTelemetry,
} from '@dltech/atlas-core'

import { openAtlasDatabase } from '../../store/database'
import { createTempDatabaseUrl } from '../../store/__tests__/harness'
import { createPerfSampler } from '../perf-sampler'

describe('perf sampler', () => {
  it('writes a window of process stats and drained counters per tick', async () => {
    resetPerfTelemetry()
    const { databaseUrl, discard } = createTempDatabaseUrl()
    const database = await openAtlasDatabase({ databaseUrl })
    try {
      let tick = Date.UTC(2026, 8, 3, 12, 0, 0)
      const sampler = createPerfSampler({
        prisma: database.prisma,
        workspace: '/work/somewhere',
        windowMs: 60_000,
        now: () => (tick += 60_000),
      })

      addPerfCounter({ key: EPerfCounter.TranscriptRepublish })
      addPerfCounter({ key: EPerfCounter.TranscriptRepublish })
      addPerfCounter({ key: EPerfCounter.ChannelChunk, delta: 40 })
      adjustPerfGauge({ key: EPerfGauge.TurnDepth, delta: 1 })

      await sampler.flush()
      await sampler.dispose()

      const rows = await database.prisma.perfSample.findMany()
      expect(rows.length).toBeGreaterThanOrEqual(1)

      const first = rows[0]!
      expect(first.pid).toBe(process.pid)
      expect(first.workspace).toBe('/work/somewhere')
      expect(first.cpuUserMs).toBeGreaterThanOrEqual(0)
      expect(first.rssMb).toBeGreaterThan(0)
      expect(first.turnActive).toBe(true)

      const payload = JSON.parse(first.counters) as {
        counters: Record<string, number>
        gauges: Record<string, number>
      }
      expect(payload.counters[EPerfCounter.TranscriptRepublish]).toBe(2)
      expect(payload.counters[EPerfCounter.ChannelChunk]).toBe(40)
      expect(payload.gauges[EPerfGauge.TurnDepth]).toBe(1)

      adjustPerfGauge({ key: EPerfGauge.TurnDepth, delta: -1 })
    } finally {
      resetPerfTelemetry()
      await database.close()
      discard()
    }
  })

  it('resets counters between windows instead of double-counting them', async () => {
    resetPerfTelemetry()
    const { databaseUrl, discard } = createTempDatabaseUrl()
    const database = await openAtlasDatabase({ databaseUrl })
    try {
      const sampler = createPerfSampler({ prisma: database.prisma, windowMs: 60_000 })

      addPerfCounter({ key: EPerfCounter.TranscriptRepublish })
      await sampler.flush()
      await sampler.flush()
      await sampler.dispose()

      const rows = await database.prisma.perfSample.findMany({ orderBy: { startedAt: 'asc' } })
      expect(rows.length).toBeGreaterThanOrEqual(2)
      const first = JSON.parse(rows[0]!.counters) as { counters: Record<string, number> }
      const second = JSON.parse(rows[1]!.counters) as { counters: Record<string, number> }
      expect(first.counters[EPerfCounter.TranscriptRepublish]).toBe(1)
      expect(second.counters).toEqual({})
    } finally {
      resetPerfTelemetry()
      await database.close()
      discard()
    }
  })
})
