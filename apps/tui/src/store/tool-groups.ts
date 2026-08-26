import type { CallId, Event, EventOfType } from '@dltech/atlas-core'

import { liveLabel, settledLabel, verbIdentity, verbOfTool, type ToolVerb } from '../ui/tool-verbs'

export enum ECallState {
  Pending = 'pending',
  Ok = 'ok',
  Failed = 'failed',
  Denied = 'denied',
}

export enum EGroupState {
  Live = 'live',
  Ok = 'ok',
  Failed = 'failed',
}

export type CallTotals = {
  added: number | null
  removed: number | null
  passed: number | null
  lines: number | null
  created: boolean
}

export type ToolCallRow = {
  callId: CallId
  name: string
  input: unknown
  target: string | null
  state: ECallState
  totals: CallTotals
  note: string | null
}

export type GroupTotals = {
  count: number
  settled: number
  added: number | null
  removed: number | null
  passed: number | null
}

export type ToolGroup = {
  key: string
  openedBy: CallId
  verb: ToolVerb
  calls: readonly ToolCallRow[]
  state: EGroupState
  totals: GroupTotals
  startedAtMs: number | null
  settledAtMs: number | null
  label: string
}

export type LiveToolCall = {
  callId: CallId
  name: string
  input: unknown
  precededByBlocks: number
}

export type LiveToolGroup = { group: ToolGroup; precededByBlocks: number }

export const NO_TOTALS: CallTotals = {
  added: null,
  removed: null,
  passed: null,
  lines: null,
  created: false,
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function numberAt(args: { source: unknown; keys: readonly string[] }): number | null {
  if (!isRecord(args.source)) return null
  for (const key of args.keys) {
    const found = args.source[key]
    if (typeof found === 'number' && Number.isFinite(found)) return found
  }
  return null
}

function stringAt(args: { source: unknown; keys: readonly string[] }): string | null {
  if (!isRecord(args.source)) return null
  for (const key of args.keys) {
    const found = args.source[key]
    if (typeof found === 'string' && found.trim().length > 0) return found
  }
  return null
}

function booleanAt(args: { source: unknown; keys: readonly string[] }): boolean {
  const source = args.source
  if (!isRecord(source)) return false
  return args.keys.some((key) => source[key] === true)
}

const totalsOfOutput = (output: unknown): CallTotals => ({
  added: numberAt({ source: output, keys: ['added', 'linesAdded'] }),
  removed: numberAt({ source: output, keys: ['removed', 'linesRemoved'] }),
  passed: numberAt({ source: output, keys: ['passed', 'pass'] }),
  lines: numberAt({ source: output, keys: ['lines'] }),
  created: booleanAt({ source: output, keys: ['created', 'isNew'] }),
})

const targetOfInput = (input: unknown): string | null =>
  stringAt({ source: input, keys: ['path', 'file', 'filePath', 'pattern', 'command', 'cmd'] })

const millisOf = (at: string | null): number | null => {
  if (at === null) return null
  const parsed = Date.parse(at)
  return Number.isFinite(parsed) ? parsed : null
}

type Settle = { at: string; state: ECallState; totals: CallTotals; note: string | null }

type CallSeed = { callId: CallId; name: string; input: unknown; at: string | null }

function settlesOf(events: readonly Event[]): Map<CallId, Settle> {
  const settles = new Map<CallId, Settle>()

  for (const event of events) {
    if (event.type === 'tool-result') {
      settles.set(event.callId, {
        at: event.at,
        state: event.error === undefined ? ECallState.Ok : ECallState.Failed,
        totals: totalsOfOutput(event.output),
        note: event.error?.message ?? null,
      })
    }

    if (event.type === 'tool-denied') {
      settles.set(event.callId, {
        at: event.at,
        state: ECallState.Denied,
        totals: NO_TOTALS,
        note: event.reason,
      })
    }
  }

  return settles
}

function rowOf(args: { seed: CallSeed; settle: Settle | undefined }): ToolCallRow {
  const { seed, settle } = args

  return {
    callId: seed.callId,
    name: seed.name,
    input: seed.input,
    target: targetOfInput(seed.input),
    state: settle?.state ?? ECallState.Pending,
    totals: settle?.totals ?? NO_TOTALS,
    note: settle?.note ?? null,
  }
}

function sumOf(args: {
  rows: readonly ToolCallRow[]
  pick: (totals: CallTotals) => number | null
}): number | null {
  const present = args.rows
    .map((row) => args.pick(row.totals))
    .filter((value): value is number => value !== null)

  return present.length === 0 ? null : present.reduce((total, value) => total + value, 0)
}

const labelOf = (args: { verb: ToolVerb; count: number; state: EGroupState }): string =>
  args.state === EGroupState.Live
    ? liveLabel(args.verb)
    : settledLabel({ verb: args.verb, count: args.count })

const stateOf = (rows: readonly ToolCallRow[]): EGroupState => {
  if (rows.some((row) => row.state === ECallState.Pending)) return EGroupState.Live
  if (rows.some((row) => row.state !== ECallState.Ok)) return EGroupState.Failed
  return EGroupState.Ok
}

function groupOf(args: {
  verb: ToolVerb
  seeds: readonly CallSeed[]
  settles: ReadonlyMap<CallId, Settle>
}): ToolGroup {
  const { verb, seeds, settles } = args
  const rows = seeds.map((seed) => rowOf({ seed, settle: settles.get(seed.callId) }))
  const first = seeds[0]
  if (first === undefined) throw new Error('a tool group needs at least one call')

  const state = stateOf(rows)
  const settledAt = seeds
    .map((seed) => settles.get(seed.callId)?.at ?? null)
    .reduce<string | null>((latest, at) => (at !== null && (latest === null || at > latest) ? at : latest), null)

  return {
    key: `tools:${first.callId}`,
    openedBy: first.callId,
    verb,
    calls: rows,
    state,
    totals: {
      count: rows.length,
      settled: rows.filter((row) => row.state !== ECallState.Pending).length,
      added: sumOf({ rows, pick: (totals) => totals.added }),
      removed: sumOf({ rows, pick: (totals) => totals.removed }),
      passed: sumOf({ rows, pick: (totals) => totals.passed }),
    },
    startedAtMs: millisOf(first.at),
    settledAtMs: state === EGroupState.Live ? null : millisOf(settledAt),
    label: labelOf({ verb, count: rows.length, state }),
  }
}

type CallRun = { verb: ToolVerb; seeds: CallSeed[] }

const brokenBy = (event: Event): boolean => {
  if (event.type === 'user-said' || event.type === 'nudge') return true
  if (event.type !== 'assistant-said') return false
  return event.parts.some((part) => part.type === 'text' && part.text.trim().length > 0)
}

const seedOf = (event: EventOfType<'tool-called'>): CallSeed => ({
  callId: event.callId,
  name: event.name,
  input: event.input,
  at: event.at,
})

function runsOfEvents(events: readonly Event[]): CallRun[] {
  const runs: CallRun[] = []
  let openIdentity: string | null = null

  for (const event of events) {
    if (brokenBy(event)) {
      openIdentity = null
      continue
    }
    if (event.type !== 'tool-called') continue

    const verb = verbOfTool(event.name)
    const identity = verbIdentity(verb)
    const open = openIdentity === identity ? runs.at(-1) : undefined

    if (open === undefined) runs.push({ verb, seeds: [seedOf(event)] })
    else open.seeds.push(seedOf(event))

    openIdentity = identity
  }

  return runs
}

export function toolGroups(events: readonly Event[]): ToolGroup[] {
  const settles = settlesOf(events)
  return runsOfEvents(events).map((run) => groupOf({ verb: run.verb, seeds: run.seeds, settles }))
}

const NO_SETTLES: ReadonlyMap<CallId, Settle> = new Map()

type LiveRun = { verb: ToolVerb; precededByBlocks: number; seeds: CallSeed[] }

export function liveToolGroups(calls: readonly LiveToolCall[]): LiveToolGroup[] {
  const runs: LiveRun[] = []
  let open: { identity: string; precededByBlocks: number } | null = null

  for (const call of calls) {
    const verb = verbOfTool(call.name)
    const identity = verbIdentity(verb)
    const adjacent =
      open !== null && open.identity === identity && open.precededByBlocks === call.precededByBlocks
    const run = adjacent ? runs.at(-1) : undefined
    const seed: CallSeed = { callId: call.callId, name: call.name, input: call.input, at: null }

    if (run === undefined) runs.push({ verb, precededByBlocks: call.precededByBlocks, seeds: [seed] })
    else run.seeds.push(seed)

    open = { identity, precededByBlocks: call.precededByBlocks }
  }

  return runs.map((run) => ({
    group: groupOf({ verb: run.verb, seeds: run.seeds, settles: NO_SETTLES }),
    precededByBlocks: run.precededByBlocks,
  }))
}
