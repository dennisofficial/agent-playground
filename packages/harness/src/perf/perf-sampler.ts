import { randomUUID } from 'node:crypto'
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks'

import {
  drainPerfCounters,
  EPerfGauge,
  readPerfGauge,
  readPerfGauges,
} from '@dltech/atlas-core'

import type { PrismaClient } from '../../prisma/generated/client'
import { retryOnWriteConflict } from '../store/retry'

export const PERF_SAMPLE_WINDOW_MS = 60_000

export type PerfSampler = {
  flush: () => Promise<void>
  dispose: () => Promise<void>
}

const MB = 1024 * 1024

const lagMs = (histogram: IntervalHistogram, percentile: number): number => {
  const value = histogram.percentile(percentile)
  return Number.isFinite(value) ? value / 1e6 : 0
}

export function createPerfSampler(args: {
  prisma: PrismaClient
  workspace?: string | undefined
  revision?: string | undefined
  windowMs?: number
  now?: () => number
}): PerfSampler {
  const now = args.now ?? Date.now
  const windowMs = args.windowMs ?? PERF_SAMPLE_WINDOW_MS
  const bootedAt = new Date(now()).toISOString()
  const lag = monitorEventLoopDelay()
  lag.enable()

  let windowStartedAt = now()
  let lastCpu = process.cpuUsage()
  let chain: Promise<void> = Promise.resolve()
  let disposed = false

  const sample = (): Promise<void> => {
    const endedAt = now()
    const cpu = process.cpuUsage(lastCpu)
    lastCpu = process.cpuUsage()
    const memory = process.memoryUsage()
    const payload = {
      counters: drainPerfCounters(),
      gauges: readPerfGauges(),
      revision: args.revision,
    }
    const row = {
      id: randomUUID(),
      pid: process.pid,
      bootedAt,
      workspace: args.workspace ?? null,
      startedAt: new Date(windowStartedAt).toISOString(),
      endedAt: new Date(endedAt).toISOString(),
      cpuUserMs: Math.round(cpu.user / 1000),
      cpuSysMs: Math.round(cpu.system / 1000),
      lagP50Ms: lagMs(lag, 50),
      lagP95Ms: lagMs(lag, 95),
      lagMaxMs: lag.max / 1e6,
      rssMb: Math.round(memory.rss / MB),
      heapMb: Math.round(memory.heapUsed / MB),
      turnActive: readPerfGauge({ key: EPerfGauge.TurnDepth }) > 0,
      counters: JSON.stringify(payload),
    }
    lag.reset()
    windowStartedAt = endedAt

    return retryOnWriteConflict({
      run: async () => {
        await args.prisma.perfSample.create({ data: row })
      },
    })
  }

  const tick = (): void => {
    chain = chain.then(() => sample()).catch(() => undefined)
  }

  const timer = setInterval(tick, windowMs)
  timer.unref?.()

  return {
    flush: async () => {
      await chain
      if (disposed) return
      await sample()
    },
    dispose: async () => {
      if (disposed) return
      disposed = true
      clearInterval(timer)
      lag.disable()
      await chain
      await sample().catch(() => undefined)
    },
  }
}
