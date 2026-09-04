import type { CliRenderer } from '@opentui/core'

import {
  addPerfCounter,
  EPerfCounter,
  EPerfGauge,
  setPerfGauge,
} from '@dltech/atlas-core'

const SAMPLE_EVERY_MS = 60_000

/**
 * The renderer counts its own frames natively; this just copies the rolling window into the perf
 * gauges on the sampler's cadence and re-baselines, so a hot PerfSample window can say what a
 * frame cost — the one cost the chunk counters cannot see, since React render and native layout
 * happen on the frame loop, downstream of the republish they follow.
 */
export function trackRenderStats(renderer: CliRenderer): void {
  renderer.setGatherStats(true)
  let lastFrameCount = 0

  const timer = setInterval(() => {
    const stats = renderer.getStats()
    setPerfGauge({ key: EPerfGauge.RenderAvgFrameMs, value: stats.averageFrameTime })
    setPerfGauge({ key: EPerfGauge.RenderMaxFrameMs, value: stats.maxFrameTime })
    addPerfCounter({ key: EPerfCounter.RenderFrames, delta: stats.frameCount - lastFrameCount })
    lastFrameCount = stats.frameCount
    renderer.resetStats()
  }, SAMPLE_EVERY_MS)
  timer.unref?.()
}
