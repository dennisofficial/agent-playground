#!/usr/bin/env bun
import { openAtlasDatabase } from '../src/store/database'

const hours = Number(process.argv[2] ?? 24)
const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString()

const database = await openAtlasDatabase()

type Row = {
  pid: number
  bootedAt: string
  workspace: string | null
  startedAt: string
  cpuUserMs: number
  cpuSysMs: number
  lagP95Ms: number
  rssMb: number
  turnActive: boolean
  counters: string
}

const rows: Row[] = await database.prisma.perfSample.findMany({
  where: { startedAt: { gte: cutoff } },
  orderBy: { startedAt: 'asc' },
})

if (rows.length === 0) {
  console.log(`No perf samples in the last ${hours}h at ${database.databaseUrl}`)
  await database.close()
  process.exit(0)
}

const cpuMs = (row: Row): number => row.cpuUserMs + row.cpuSysMs

const shortWorkspace = (workspace: string | null): string => {
  if (workspace === null) return '?'
  const parts = workspace.split('/')
  return parts.slice(-2).join('/')
}

type Instance = {
  key: string
  pid: number
  workspace: string | null
  windows: Row[]
}

const instances = new Map<string, Instance>()
for (const row of rows) {
  const key = `${row.pid}:${row.bootedAt}`
  const found = instances.get(key)
  if (found) found.windows.push(row)
  else instances.set(key, { key, pid: row.pid, workspace: row.workspace, windows: [row] })
}

const revisionOf = (row: Row): string => {
  try {
    const parsed = JSON.parse(row.counters) as { revision?: string }
    return parsed.revision ?? '-'
  } catch {
    return '-'
  }
}

console.log(`Perf samples, last ${hours}h — ${rows.length} windows across ${instances.size} instances\n`)
console.log('instance (pid · workspace)         revision  windows  avg cpu%  max cpu%  avg lagP95  % turn-active')
for (const instance of [...instances.values()].sort(
  (a, b) => b.windows.reduce((sum, r) => sum + cpuMs(r), 0) - a.windows.reduce((sum, r) => sum + cpuMs(r), 0),
)) {
  const totals = instance.windows.reduce(
    (acc, row) => ({
      cpu: acc.cpu + cpuMs(row),
      lag: acc.lag + row.lagP95Ms,
      busy: acc.busy + (row.turnActive ? 1 : 0),
    }),
    { cpu: 0, lag: 0, busy: 0 },
  )
  const windowMs =
    instance.windows.length > 1
      ? (Date.parse(instance.windows.at(-1)!.startedAt) - Date.parse(instance.windows[0]!.startedAt)) /
        (instance.windows.length - 1)
      : 60_000
  const avgCpu = totals.cpu / instance.windows.length / windowMs * 100
  const maxCpu = Math.max(...instance.windows.map((row) => cpuMs(row))) / windowMs * 100
  const revision = revisionOf(instance.windows.at(-1)!)
  const label = `${instance.pid} · ${shortWorkspace(instance.workspace)}`.padEnd(34)
  console.log(
    `${label} ${revision.padEnd(9)} ${String(instance.windows.length).padStart(7)}  ${avgCpu.toFixed(1).padStart(8)}  ${maxCpu.toFixed(1).padStart(8)}  ${(totals.lag / instance.windows.length).toFixed(1).padStart(10)}  ${(totals.busy / instance.windows.length * 100).toFixed(0).padStart(12)}`,
  )
}

const compactCounters = (raw: string): string => {
  try {
    const parsed = JSON.parse(raw) as
      | { counters: Record<string, number>; gauges: Record<string, number> }
      | Record<string, number>
    if ('counters' in parsed) {
      const counters = Object.entries(parsed.counters)
        .map(([key, value]) => `${key}=${typeof value === 'number' ? Math.round(value) : value}`)
        .join(' ')
      const gauges = Object.entries(parsed.gauges)
        .filter(([, value]) => value !== 0)
        .map(([key, value]) => `${key}=${value}`)
        .join(' ')
      return [counters, gauges && `gauges[${gauges}]`].filter(Boolean).join('  ')
    }
    return raw
  } catch {
    return raw
  }
}

const hottest = [...rows].sort((a, b) => cpuMs(b) - cpuMs(a)).slice(0, 15)
console.log('\nHottest windows:')
console.log('startedAt            pid      cpu%  lagP95ms  rssMb  turn  counters')
for (const row of hottest) {
  const windowMs = 60_000
  console.log(
    `${row.startedAt.slice(0, 19)}  ${String(row.pid).padEnd(8)} ${(cpuMs(row) / windowMs * 100).toFixed(1).padStart(5)}  ${row.lagP95Ms.toFixed(1).padStart(8)}  ${String(row.rssMb).padStart(5)}  ${row.turnActive ? 'yes ' : 'no  '}  ${compactCounters(row.counters)}`,
  )
}

await database.close()
