const SECONDS_PER_SUFFIX: Record<string, number> = { s: 1, m: 60, h: 3_600, d: 86_400 }

const SLEEP = /\bsleep\s+(\d+(?:\.\d+)?)\s*([smhd])?\b/g
const LOOP_KEYWORD = /(?<=^|[\s;&|(])(?:for|while|until)(?=\s)/g
const DO_OR_DONE = /(?<=^|[\s;&|(])(?:do|done)(?=$|[\s;&|)])/g
const SEQ_CALL = /\$\(\s*seq\s+([^)]+)\)/
const BRACE_RANGE = /\{\s*(\d+)\s*\.\.\s*(\d+)\s*(?:\.\.\s*(\d+)\s*)?\}/
const IN_LIST = /\bin\s+([^;\n]*)/
const EXPANDED = /[$*?`[\]{}]/

export const SLEEP_BUDGET_SECONDS = 30

export type IdleReading = {
  seconds: number
  unbounded: boolean
  iterations?: number | undefined
}

export function sleptSeconds(command: string): number {
  let total = 0
  for (const [, amount, suffix] of command.matchAll(SLEEP)) {
    if (amount === undefined) continue
    total += Number(amount) * (SECONDS_PER_SUFFIX[suffix ?? 's'] ?? 1)
  }
  return total
}

function spanOf(args: { first: number; last: number; step: number }): number | undefined {
  if (args.step === 0) return undefined
  return Math.floor(Math.abs(args.last - args.first) / Math.abs(args.step)) + 1
}

function seqTrips(callArguments: string): number | undefined {
  const counts = callArguments.trim().split(/\s+/).map(Number)
  if (counts.some((count) => !Number.isFinite(count))) return undefined

  const [first, second, third] = counts
  if (first === undefined) return undefined
  if (counts.length === 1) return Math.max(Math.floor(first), 0)
  if (counts.length === 2 && second !== undefined) {
    return second < first ? 0 : spanOf({ first, last: second, step: 1 })
  }
  if (counts.length === 3 && second !== undefined && third !== undefined) {
    return spanOf({ first, last: third, step: second })
  }
  return undefined
}

function listTrips(header: string): number | undefined {
  const items = IN_LIST.exec(header)?.[1]?.trim()
  if (items === undefined || items === '') return undefined
  if (EXPANDED.test(items)) return undefined
  return items.split(/\s+/).length
}

function tripsFrom(header: string): number | undefined {
  if (!header.startsWith('for')) return undefined

  const seq = SEQ_CALL.exec(header)?.[1]
  if (seq !== undefined) return seqTrips(seq)

  const brace = BRACE_RANGE.exec(header)
  const first = brace?.[1]
  const last = brace?.[2]
  if (first !== undefined && last !== undefined) {
    return spanOf({ first: Number(first), last: Number(last), step: Number(brace?.[3] ?? 1) })
  }

  return listTrips(header)
}

type Loop = {
  headerStart: number
  trips: number | undefined
  body: string
  resumeAt: number
}

function closingDone(args: { source: string; from: number }): {
  bodyEnd: number
  resumeAt: number
} {
  DO_OR_DONE.lastIndex = args.from
  let depth = 1
  let token = DO_OR_DONE.exec(args.source)
  while (token !== null) {
    depth += token[0] === 'do' ? 1 : -1
    if (depth === 0) return { bodyEnd: token.index, resumeAt: token.index + token[0].length }
    token = DO_OR_DONE.exec(args.source)
  }
  return { bodyEnd: args.source.length, resumeAt: args.source.length }
}

function findLoop(args: { source: string; from: number }): Loop | undefined {
  LOOP_KEYWORD.lastIndex = args.from
  const keyword = LOOP_KEYWORD.exec(args.source)
  if (keyword === null) return undefined

  DO_OR_DONE.lastIndex = keyword.index
  let opener = DO_OR_DONE.exec(args.source)
  while (opener !== null && opener[0] !== 'do') opener = DO_OR_DONE.exec(args.source)
  if (opener === null) return undefined

  const bodyStart = opener.index + opener[0].length
  const closing = closingDone({ source: args.source, from: bodyStart })

  return {
    headerStart: keyword.index,
    trips: tripsFrom(args.source.slice(keyword.index, opener.index)),
    body: args.source.slice(bodyStart, closing.bodyEnd),
    resumeAt: closing.resumeAt,
  }
}

function readSegment(segment: string): IdleReading {
  let seconds = 0
  let unbounded = false
  let iterations: number | undefined

  let cursor = 0
  while (cursor < segment.length) {
    const loop = findLoop({ source: segment, from: cursor })
    if (loop === undefined) break

    seconds += sleptSeconds(segment.slice(cursor, loop.headerStart))
    cursor = loop.resumeAt

    const body = readSegment(loop.body)
    if (!body.unbounded && body.seconds === 0) continue
    if (body.unbounded) unbounded = true

    if (loop.trips === undefined) {
      unbounded = true
      seconds += body.seconds
      continue
    }
    seconds += body.seconds * loop.trips
    iterations ??= loop.trips
  }

  return { seconds: seconds + sleptSeconds(segment.slice(cursor)), unbounded, iterations }
}

export function readIdling(args: { command: string; timeoutMs: number }): IdleReading {
  const ceiling = args.timeoutMs / 1_000
  const reading = readSegment(args.command)
  return {
    seconds: reading.unbounded ? ceiling : Math.min(reading.seconds, ceiling),
    unbounded: reading.unbounded,
    iterations: reading.iterations,
  }
}

export function idledSeconds(args: { command: string; timeoutMs: number }): number {
  return readIdling(args).seconds
}

export function waitsBySleeping(args: { command: string; timeoutMs: number }): boolean {
  const reading = readIdling(args)
  return reading.unbounded || reading.seconds > SLEEP_BUDGET_SECONDS
}
