#!/usr/bin/env bun
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { drainPerfCounters, EPerfCounter, type ThreadId } from '@dltech/atlas-core'
import {
  buildHarness,
  BunShellRegistry,
  ETurnStatus,
  HookChain,
  providerPartsFor,
  SystemClock,
  type AtlasHarness,
} from '@dltech/atlas-harness'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'

const AGENTS_PER_THREAD = 5
const SHELLS_PER_AGENT = 4
const SAMPLE_EVERY_MS = 1_000
const FAILURE_BACKOFF_MS = 50

const SHELL_COMMAND = 'i=0; while true; do i=$((i+1)); echo "bench-shell line $i"; sleep 0.05; done'
const TURN_PROMPT = 'Stream the full benchmark status report, then stop.'

const STEP_TEXT = Array.from(
  { length: 256 },
  (_, index) => `section ${index}: the worker drifted past its quota while the queue kept growing`,
).join('\n')

type BenchFlags = { threads: number; seconds: number }

const readFlag = (args: { argv: readonly string[]; name: string }): string | undefined => {
  const prefix = `--${args.name}=`
  return args.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length)
}

const positiveInteger = (args: { name: string; raw: string | undefined; fallback: number }): number => {
  if (args.raw === undefined) return args.fallback
  const value = Number(args.raw)
  if (Number.isInteger(value) && value >= 1) return value
  console.error(`--${args.name} must be a positive integer, got "${args.raw}"`)
  process.exit(1)
}

const parseFlags = (argv: readonly string[]): BenchFlags => ({
  threads: positiveInteger({ name: 'threads', raw: readFlag({ argv, name: 'threads' }), fallback: 1 }),
  seconds: positiveInteger({ name: 'seconds', raw: readFlag({ argv, name: 'seconds' }), fallback: 30 }),
})

const benchModel = (): MockLanguageModelV4 => {
  const parts = providerPartsFor({ text: STEP_TEXT })
  return new MockLanguageModelV4({
    provider: 'bench',
    modelId: 'bench-kimi-speed',
    doStream: async () => ({
      stream: simulateReadableStream({ chunks: parts, initialDelayInMs: 0, chunkDelayInMs: 0 }),
    }),
  })
}

type BenchSamples = {
  cpuMicros: number
  peakRssBytes: number
  counters: Map<string, number>
}

const startSampler = (): { samples: BenchSamples; stop: () => void } => {
  const samples: BenchSamples = { cpuMicros: 0, peakRssBytes: 0, counters: new Map() }
  let stopped = false
  let previous = process.cpuUsage()
  const collect = (): void => {
    const cpu = process.cpuUsage()
    samples.cpuMicros += cpu.user - previous.user + (cpu.system - previous.system)
    previous = cpu
    samples.peakRssBytes = Math.max(samples.peakRssBytes, process.memoryUsage().rss)
    for (const [key, value] of Object.entries(drainPerfCounters())) {
      samples.counters.set(key, (samples.counters.get(key) ?? 0) + value)
    }
  }
  const timer = setInterval(collect, SAMPLE_EVERY_MS)
  return {
    samples,
    stop: () => {
      if (stopped) return
      stopped = true
      clearInterval(timer)
      collect()
    },
  }
}

type AgentTally = { completed: number; failed: number }

const runAgent = async (args: {
  harness: AtlasHarness
  threadId: ThreadId
  deadline: number
}): Promise<AgentTally> => {
  let completed = 0
  let failed = 0
  while (Date.now() < args.deadline) {
    const outcome = await args.harness.runner.say({ threadId: args.threadId, text: TURN_PROMPT })
    if (outcome.status === ETurnStatus.Completed) {
      completed += 1
      continue
    }
    failed += 1
    await Bun.sleep(FAILURE_BACKOFF_MS)
  }
  return { completed, failed }
}

const startShells = (args: { shells: BunShellRegistry; threadId: ThreadId }): void => {
  for (let index = 0; index < SHELLS_PER_AGENT; index += 1) {
    const started = args.shells.start({
      threadId: args.threadId,
      command: SHELL_COMMAND,
      description: `bench shell ${index}`,
    })
    if (!started.ok) throw new Error(`bench shell failed to start: ${started.reason}`)
  }
}

const spawnAgents = async (args: {
  harness: AtlasHarness
  shells: BunShellRegistry
  threads: number
}): Promise<readonly ThreadId[]> => {
  const agents: ThreadId[] = []
  for (let parent = 0; parent < args.threads; parent += 1) {
    const parentThread = await args.harness.threads.create({ title: `bench-parent-${parent}` })
    for (let agent = 0; agent < AGENTS_PER_THREAD; agent += 1) {
      const thread = await args.harness.threads.create({
        title: `bench-agent-${parent}-${agent}`,
        agent: { spawnedBy: parentThread.id, type: 'bench-agent' },
      })
      startShells({ shells: args.shells, threadId: thread.id })
      agents.push(thread.id)
    }
  }
  return agents
}

const counter = (samples: BenchSamples, key: EPerfCounter): number => samples.counters.get(key) ?? 0

const printReport = (args: {
  flags: BenchFlags
  agents: number
  wallSeconds: number
  tally: AgentTally
  samples: BenchSamples
}): void => {
  const chunks = counter(args.samples, EPerfCounter.HarnessChunk)
  const turnMs = counter(args.samples, EPerfCounter.TurnMs)
  const rows: [string, string][] = [
    ['threads', String(args.flags.threads)],
    ['agents', String(args.agents)],
    ['shells', String(args.agents * SHELLS_PER_AGENT)],
    ['wall seconds', args.wallSeconds.toFixed(2)],
    ['turns completed', String(args.tally.completed)],
    ['turns failed', String(args.tally.failed)],
    ['turns / second', (args.tally.completed / args.wallSeconds).toFixed(1)],
    ['model chunks', String(chunks)],
    ['chunks / second', (chunks / args.wallSeconds).toFixed(1)],
    ['harness chunk ms', counter(args.samples, EPerfCounter.HarnessChunkMs).toFixed(0)],
    ['turn ms total', turnMs.toFixed(0)],
    ['turn ms avg', (turnMs / Math.max(args.tally.completed, 1)).toFixed(1)],
    ['cpu seconds', (args.samples.cpuMicros / 1_000_000).toFixed(2)],
    ['cpu avg %', ((args.samples.cpuMicros / 1_000_000 / args.wallSeconds) * 100).toFixed(1)],
    ['peak rss MB', (args.samples.peakRssBytes / 1024 / 1024).toFixed(0)],
  ]
  const width = Math.max(...rows.map(([label]) => label.length))
  console.log('\nbench-load report')
  for (const [label, value] of rows) console.log(`  ${label.padEnd(width)}  ${value}`)
}

const sumTallies = (tallies: readonly AgentTally[]): AgentTally =>
  tallies.reduce<AgentTally>(
    (sum, each) => ({ completed: sum.completed + each.completed, failed: sum.failed + each.failed }),
    { completed: 0, failed: 0 },
  )

const main = async (): Promise<void> => {
  const flags = parseFlags(process.argv.slice(2))
  const root = mkdtempSync(join(tmpdir(), 'atlas-bench-'))
  const harness = await buildHarness({
    model: benchModel(),
    databaseUrl: `file:${join(root, 'bench.db')}`,
    launchDirectory: root,
  })
  const shells = new BunShellRegistry(root, new SystemClock(), () => new HookChain({}))

  const sampler = startSampler()
  const startedAt = performance.now()
  let agents = 0
  let tally: AgentTally = { completed: 0, failed: 0 }
  let wallSeconds = 0
  try {
    const agentIds = await spawnAgents({ harness, shells, threads: flags.threads })
    agents = agentIds.length
    const deadline = Date.now() + flags.seconds * 1_000
    const tallies = await Promise.all(agentIds.map((threadId) => runAgent({ harness, threadId, deadline })))
    tally = sumTallies(tallies)
    wallSeconds = (performance.now() - startedAt) / 1_000
  } finally {
    sampler.stop()
    await shells.closeAll()
    await harness.close()
    rmSync(root, { recursive: true, force: true })
  }
  printReport({ flags, agents, wallSeconds, tally, samples: sampler.samples })
  console.log('\ncleanup: shells killed, database closed, temp directory removed')
}

await main()
