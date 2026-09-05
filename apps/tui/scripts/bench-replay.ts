#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { toThreadId, type ThreadId } from '@dltech/atlas-core'
import {
  buildHarness,
  BunShellRegistry,
  HookChain,
  SystemClock,
} from '@dltech/atlas-harness'

import { benchModel } from './bench-model'
import { mountBenchRender, publishingRunner } from './bench-render'

const CRASH_SCREEN_MARKER = 'something broke'

type ReplayFlags = {
  db: string
  threads: number
  match: string | undefined
  minEvents: number
  maxEvents: number
  seconds: number
  width: number
  height: number
}

const readFlag = (argv: readonly string[], name: string): string | undefined => {
  const prefix = `--${name}=`
  return argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length)
}

const positiveInteger = (name: string, raw: string | undefined, fallback: number): number => {
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (Number.isInteger(value) && value >= 1) return value
  console.error(`--${name} must be a positive integer, got "${raw}"`)
  process.exit(1)
}

const parseFlags = (argv: readonly string[]): ReplayFlags => ({
  db: readFlag(argv, 'db') ?? `${process.env.HOME}/.atlas/harness.db`,
  threads: positiveInteger('threads', readFlag(argv, 'threads'), 5),
  match: readFlag(argv, 'match'),
  minEvents: positiveInteger('minevents', readFlag(argv, 'minevents'), 1),
  maxEvents: positiveInteger('maxevents', readFlag(argv, 'maxevents'), Number.MAX_SAFE_INTEGER),
  seconds: positiveInteger('seconds', readFlag(argv, 'seconds'), 3),
  width: positiveInteger('width', readFlag(argv, 'width'), 150),
  height: positiveInteger('height', readFlag(argv, 'height'), 40),
})

type Candidate = { id: string; title: string | null; events: number; bytes: number }

const queryJson = <T>(db: string, sql: string): T[] =>
  JSON.parse(execFileSync('sqlite3', ['-json', db, sql], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }))

const pickThreads = (db: string, flags: ReplayFlags): Candidate[] => {
  const where =
    flags.match === undefined
      ? 't.spawnerThreadId IS NULL'
      : `t.title LIKE '%${flags.match.replaceAll("'", "''")}%'`
  return queryJson<Candidate>(
    db,
    `SELECT t.id, t.title, COUNT(e.id) AS events, SUM(LENGTH(e.body)) AS bytes
     FROM Thread t JOIN Event e ON e.threadId = t.id
     WHERE ${where}
     GROUP BY t.id
     HAVING events BETWEEN ${flags.minEvents} AND ${flags.maxEvents}
     ORDER BY events DESC LIMIT ${flags.threads}`,
  )
}

type Scroller = {
  scrollTop: number
  scrollHeight: number
  viewport: { height: number }
  content: { getChildren: () => readonly unknown[] }
  scrollTo: (offset: number) => void
}

const isScroller = (node: unknown): node is Scroller =>
  typeof node === 'object' && node !== null && 'scrollTo' in node && 'content' in node

const findScroller = (node: unknown): Scroller | null => {
  if (isScroller(node)) return node
  const children = (node as { getChildren?: () => readonly unknown[] }).getChildren?.() ?? []
  for (const child of children) {
    const found = findScroller(child)
    if (found !== null) return found
  }
  return null
}

type Cpu = { micros: number }

const cpuNow = (): Cpu => {
  const usage = process.cpuUsage()
  return { micros: usage.user + usage.system }
}

const cpuPercent = (before: Cpu, after: Cpu, wallMs: number): number =>
  ((after.micros - before.micros) / 1_000 / wallMs) * 100

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

type RenderHandle = Awaited<ReturnType<typeof mountBenchRender>>

const settle = async (render: RenderHandle): Promise<number> => {
  const startedAt = performance.now()
  let lastFrame = ''
  let stablePasses = 0
  while (stablePasses < 3 && performance.now() - startedAt < 30_000) {
    await render.flush()
    await sleep(100)
    const frame = render.frameText()
    stablePasses = frame === lastFrame ? stablePasses + 1 : 0
    lastFrame = frame
  }
  return performance.now() - startedAt
}

const sweep = async (args: {
  scroller: Scroller
  flush: () => Promise<void>
}): Promise<{ wallMs: number; cpu: number; maxChildren: number }> => {
  const step = Math.max(1, args.scroller.viewport.height)
  const furthest = Math.max(0, args.scroller.scrollHeight - args.scroller.viewport.height)
  const cpuStart = cpuNow()
  const startedAt = performance.now()
  let maxChildren = 0
  for (let top = furthest; top > 0; top -= step) {
    args.scroller.scrollTo(top)
    await args.flush()
    maxChildren = Math.max(maxChildren, args.scroller.content.getChildren().length)
  }
  args.scroller.scrollTo(0)
  await args.flush()
  args.scroller.scrollTo(furthest)
  await args.flush()
  const wallMs = performance.now() - startedAt
  return { wallMs, cpu: cpuPercent(cpuStart, cpuNow(), wallMs), maxChildren }
}

type ReplayRow = {
  title: string
  events: number
  turns: number
  settleMs: number
  idleCpu: number
  sweepWallMs: number
  sweepCpu: number
  frames: number
  maxChildren: number
  peakRssMb: number
  crashed: boolean
}

const printReport = (rows: readonly ReplayRow[]): void => {
  const cell = (value: unknown): string => String(value)
  const columns: [string, (row: ReplayRow) => unknown][] = [
    ['thread', (row) => row.title],
    ['events', (row) => row.events],
    ['turns', (row) => row.turns],
    ['settle ms', (row) => row.settleMs.toFixed(0)],
    ['idle cpu %', (row) => row.idleCpu.toFixed(1)],
    ['sweep ms', (row) => row.sweepWallMs.toFixed(0)],
    ['sweep cpu %', (row) => row.sweepCpu.toFixed(1)],
    ['frames', (row) => row.frames],
    ['max mounted', (row) => row.maxChildren],
    ['peak rss MB', (row) => row.peakRssMb.toFixed(0)],
    ['crashed', (row) => (row.crashed ? 'yes' : 'no')],
  ]
  console.log('\nbench-replay report')
  console.log(`  ${columns.map(([label]) => label).join('  |  ')}`)
  for (const row of rows) {
    console.log(`  ${columns.map(([, read]) => cell(read(row))).join('  |  ')}`)
  }
}

const main = async (): Promise<void> => {
  const flags = parseFlags(process.argv.slice(2))
  const root = mkdtempSync(join(tmpdir(), 'atlas-replay-'))
  const copy = join(root, 'replay.db')
  execFileSync('sqlite3', [flags.db, `.backup '${copy}'`])
  const candidates = pickThreads(copy, flags)
  if (candidates.length === 0) {
    console.error(`no threads matched in ${flags.db}`)
    rmSync(root, { recursive: true, force: true })
    process.exit(1)
  }

  const harness = await buildHarness({
    model: benchModel(),
    databaseUrl: `file:${copy}`,
    launchDirectory: root,
  })
  const { channel, runner } = publishingRunner({ harness, root })
  const shells = new BunShellRegistry(root, new SystemClock(), () => new HookChain({}))

  const rows: ReplayRow[] = []
  try {
    for (const candidate of candidates) {
      const threadId: ThreadId = toThreadId(candidate.id)
      const [events, turns] = await Promise.all([
        harness.log.read({ threadId }),
        harness.ledger.forThread({ threadId }),
      ])
      const mountStart = performance.now()
      const render = await mountBenchRender({
        root,
        harness,
        shells,
        channel,
        runner,
        threadId,
        opened: { events, turns, name: candidate.title },
        width: flags.width,
        height: flags.height,
      }).catch((error: unknown) => {
        rows.push({
          title: (candidate.title ?? candidate.id).slice(0, 32),
          events: candidate.events,
          turns: turns.length,
          settleMs: 0,
          idleCpu: 0,
          sweepWallMs: 0,
          sweepCpu: 0,
          frames: 0,
          maxChildren: 0,
          peakRssMb: process.memoryUsage().rss / 1024 / 1024,
          crashed: true,
        })
        console.error(`  mount failed for "${candidate.title}": ${String(error).split('\n')[0]}`)
        return null
      })
      if (render === null) continue
      let peakRss = process.memoryUsage().rss
      try {
        const settleMs = performance.now() - mountStart + (await settle(render))
        peakRss = Math.max(peakRss, process.memoryUsage().rss)

        const idleStart = cpuNow()
        const idleBegin = performance.now()
        await sleep(flags.seconds * 1_000)
        const idleCpu = cpuPercent(idleStart, cpuNow(), performance.now() - idleBegin)
        peakRss = Math.max(peakRss, process.memoryUsage().rss)

        const frameCountBefore = render.framesRendered()
        const scroller = findScroller(render.root())
        const flush = async (): Promise<void> => {
          await sleep(0)
          await render.flush()
        }
        const swept =
          scroller === null
            ? { wallMs: 0, cpu: 0, maxChildren: 0 }
            : await sweep({ scroller, flush })
        peakRss = Math.max(peakRss, process.memoryUsage().rss)

        rows.push({
          title: (candidate.title ?? candidate.id).slice(0, 32),
          events: candidate.events,
          turns: turns.length,
          settleMs,
          idleCpu,
          sweepWallMs: swept.wallMs,
          sweepCpu: swept.cpu,
          frames: render.framesRendered() - frameCountBefore,
          maxChildren: swept.maxChildren,
          peakRssMb: peakRss / 1024 / 1024,
          crashed: render.frameText().includes(CRASH_SCREEN_MARKER),
        })
      } finally {
        await render.close()
      }
    }
  } finally {
    await shells.closeAll()
    await harness.close()
    rmSync(root, { recursive: true, force: true })
  }
  printReport(rows)
}

await main()
