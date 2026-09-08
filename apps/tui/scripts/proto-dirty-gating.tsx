#!/usr/bin/env bun
/**
 * PROTOTYPE (throwaway): before/after measurement for dirty-gating the OpenTUI paint walk.
 *
 *   script -q /dev/null bun apps/tui/scripts/proto-dirty-gating.tsx           — shimmering line
 *   script -q /dev/null bun apps/tui/scripts/proto-dirty-gating.tsx --static  — same scene, frozen
 *
 * Needs a PTY (the real renderer); prints one result line to stdout after teardown.
 */
import { createCliRenderer } from '@opentui/core'
import { createRoot } from '@opentui/react'
import React from 'react'

import { EDetail } from '../src/store/tools'
import { NOT_EXPANDABLE } from '../src/ui/components/blocks/more-toggle'
import { ToolDetail } from '../src/ui/components/blocks/tool-detail'
import { ShimmerLine } from '../src/ui/components/shimmer-line'
import { grammarsReady } from '../src/ui/markdown/__tests__/harness'

const LABEL = 'Thinking for 12s (↓ 1.2k tokens · esc to interrupt)'
const PANELS = 6
const WARMUP_MS = 1200
const MEASURE_MS = 4000

const EDIT_CALL = {
  callId: 'call-2',
  name: 'edit',
  input: { path: '/tmp/a.ts', oldString: 'a', newString: 'b' },
  output: {
    path: '/tmp/a.ts',
    diff: '--- a/a.ts\n+++ b/a.ts\n@@ -1,3 +1,3 @@\n const x = 1\n-const y = a\n+const y = b\n const z = 3\n',
  },
  settled: true,
  failed: false,
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

await grammarsReady()

const renderer = await createCliRenderer({ exitOnCtrlC: true })
const root = createRoot(renderer)
const panels = []
for (let i = 0; i < PANELS; i++) {
  panels.push(
    React.createElement(ToolDetail, {
      key: i,
      detail: EDetail.Diff,
      call: EDIT_CALL as never,
      inner: 80,
      cwd: '/tmp',
      expand: NOT_EXPANDABLE,
    }),
  )
}
const isStatic = process.argv.includes('--static')
root.render(
  React.createElement(
    'box',
    { flexDirection: 'column', width: '100%', height: '100%' },
    React.createElement('scrollbox', { flexGrow: 1 }, ...panels),
    isStatic ? React.createElement('text', null, LABEL) : React.createElement(ShimmerLine, { label: LABEL }),
  ),
)

await sleep(WARMUP_MS)
const cpuBefore = process.cpuUsage()
const framesBefore = renderer.getStats().frameCount
const started = performance.now()
await sleep(MEASURE_MS)
const cpu = process.cpuUsage(cpuBefore)
const frames = renderer.getStats().frameCount - framesBefore
const wall = performance.now() - started
renderer.destroy()
const cpuPct = (((cpu.user + cpu.system) / 1000 / wall) * 100).toFixed(1)
const msPerFrame = ((cpu.user + cpu.system) / 1000 / Math.max(1, frames)).toFixed(2)
console.log(
  `PROBE-RESULT mode=${isStatic ? 'static' : 'shimmer'} frames=${frames} fps=${(frames / (wall / 1000)).toFixed(1)} cpuPct=${cpuPct} msPerFrame=${msPerFrame}`,
)
process.exit(0)
