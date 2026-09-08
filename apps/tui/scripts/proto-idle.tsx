#!/usr/bin/env bun
/**
 * PROTOTYPE (throwaway): what does one idle Atlas tile burn? Mounts the real App with no turn
 * running, settles, then counts frames and CPU over a quiet window. Must print zero frames.
 *
 *   bun apps/tui/scripts/proto-idle.tsx
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildHarness, BunShellRegistry, HookChain, SystemClock } from '@dltech/atlas-harness'

import { benchModel } from './bench-model'
import { mountBenchRender, publishingRunner } from './bench-render'

const WARMUP_MS = 1_000
const MEASURE_MS = 5_000

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const root = mkdtempSync(join(tmpdir(), 'atlas-idle-'))
const harness = await buildHarness({
  model: benchModel(),
  databaseUrl: `file:${join(root, 'idle.db')}`,
  launchDirectory: root,
})
const { channel, runner } = publishingRunner({ harness, root })
const shells = new BunShellRegistry(root, new SystemClock(), () => new HookChain({}))
const visibleThread = await harness.threads.create({ title: 'idle-visible' })
const render = await mountBenchRender({ root, harness, shells, channel, runner, threadId: visibleThread.id })

await sleep(WARMUP_MS)
const cpuBefore = process.cpuUsage()
const framesBefore = render.framesRendered()
const started = performance.now()
await sleep(MEASURE_MS)
const cpu = process.cpuUsage(cpuBefore)
const frames = render.framesRendered() - framesBefore
const wall = performance.now() - started

await render.close()
await shells.closeAll()
await harness.close()
rmSync(root, { recursive: true, force: true })

console.log(
  `IDLE-RESULT frames=${frames} fps=${(frames / (wall / 1000)).toFixed(1)} cpuPct=${(((cpu.user + cpu.system) / 1000 / wall) * 100).toFixed(1)}`,
)
process.exit(0)
