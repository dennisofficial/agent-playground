/**
 * The middle step: classification in, rows out.
 *
 * Deliberately not inside the renderer. Grouping is a decision about MEANING, not about drawing, and
 * keeping it here is what lets a run be measured — how many rows does this transcript actually cost?
 * — without standing up a terminal.
 */

import { settled, type ToolCall } from '../tool-runs'
import { classify } from './classify'
import { CLAUSES, EGather, EToolClass, type Classification } from './kinds'

export type Read = { call: ToolCall; reading: Classification }

export type Segment =
  | { kind: 'sentence'; key: string; reads: readonly Read[] }
  | { kind: 'alone'; key: string; read: Read; repeats: number }

/**
 * A named command that happened three times in a row is one fact, not three rows.
 *
 * `Typecheck clean` × 3 is the shape this catches: the agent iterating, every iteration printing the
 * same sentence. Only ADJACENT and only IDENTICAL — two different typecheck results stay two rows,
 * because the second one is news.
 */
const repeats = (segment: Segment | undefined, reading: Classification): boolean =>
  segment !== undefined && segment.kind === 'alone' && segment.read.reading.line === reading.line

/**
 * A sentence covers a run of ADJACENT gathered calls, and a classified command breaks it.
 *
 * The alternative was tried and is wrong: merging every gathered call of a step into one sentence
 * hoisted to the first of them reads `Read 8 files …` / `Ran the tests`, with the tests ABOVE work
 * that happened before them and, while a turn is live, a settled row sitting under an in-flight one.
 * Aggregation is allowed to summarise; it is not allowed to reorder. So the classification decides
 * the boundary and the boundary is where it actually fell.
 */
export function segmentsOf(args: { calls: readonly ToolCall[]; cwd: string }): Segment[] {
  const segments: Segment[] = []

  for (const call of args.calls) {
    const reading = classify({ call, cwd: args.cwd })
    const read: Read = { call, reading }
    const open = segments.at(-1)

    if (reading.klass === EToolClass.Gathered) {
      if (open?.kind === 'sentence') {
        segments[segments.length - 1] = { ...open, reads: [...open.reads, read] }
        continue
      }
      segments.push({ kind: 'sentence', key: call.callId, reads: [read] })
      continue
    }

    if (reading.klass === EToolClass.Command && repeats(open, reading) && open?.kind === 'alone') {
      segments[segments.length - 1] = { ...open, read, repeats: open.repeats + 1 }
      continue
    }
    segments.push({ kind: 'alone', key: call.callId, read, repeats: 1 })
  }

  return segments.map(alone)
}

/**
 * A group of one is not a group.
 *
 * `Ran 1 command` is strictly worse than the thing it is standing in for — the model already wrote
 * `Wait for the full test suite` on the call, and a sentence that counts to one throws that away and
 * charges a click to get it back. So a lone gathered call is drawn as itself, with its own prose, its
 * own measure and its own detail.
 */
const alone = (segment: Segment): Segment => {
  if (segment.kind === 'alone') return segment
  const only = segment.reads.length === 1 ? segment.reads[0] : undefined
  if (only === undefined) return segment
  return { kind: 'alone', key: segment.key, read: only, repeats: 1 }
}

const count = (value: number): string => value.toLocaleString('en-US')

/**
 * The clause order, fixed rather than first-seen.
 *
 * A sentence whose order depends on which call happened to land first reads differently every time
 * for no reason a reader can act on, and puts `checked 13 shells` in front of `read 9 files`. This
 * is the order of consequence: what it learned, then how hard it looked, then what it merely watched.
 */
const CLAUSE_ORDER: readonly EGather[] = [
  EGather.Read,
  EGather.Search,
  EGather.List,
  EGather.Run,
  EGather.Watch,
]

export function sentenceOf(reads: readonly Read[]): string {
  const tally = new Map<EGather, number>()
  for (const read of reads) {
    if (read.reading.gather === null) continue
    tally.set(read.reading.gather, (tally.get(read.reading.gather) ?? 0) + 1)
  }

  const clauses = CLAUSE_ORDER.filter((gather) => tally.has(gather)).map((gather) => {
    const clause = CLAUSES[gather]
    const many = tally.get(gather) ?? 0
    return `${clause.verb} ${count(many)} ${many === 1 ? clause.noun[0] : clause.noun[1]}`
  })

  const sentence = clauses.join(', ')
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}`
}

export function measureOfSentence(reads: readonly Read[]): string {
  const totals = new Map<EGather, number>()

  for (const read of reads) {
    if (read.reading.gather === null || read.reading.metric === null) continue
    if (CLAUSES[read.reading.gather].unit === null) continue
    totals.set(read.reading.gather, (totals.get(read.reading.gather) ?? 0) + read.reading.metric)
  }

  const failed = reads.filter((read) => read.reading.failed).length

  return [
    // Same order as the clauses, for the same reason: a measure whose order depends on which call
    // happened to land first reads differently every time for nothing a reader can act on.
    ...CLAUSE_ORDER.filter((gather) => (totals.get(gather) ?? 0) > 0).map((gather) => {
      const unit = CLAUSES[gather].unit
      const sum = totals.get(gather) ?? 0
      return unit === null ? '' : ` · ${count(sum)} ${sum === 1 ? unit[0] : unit[1]}`
    }),
    failed > 0 ? ` · ${count(failed)} failed` : '',
  ].join('')
}

/**
 * What the run says in one line — the same words its first row draws.
 *
 * `TranscriptEntry.text` is what the peek line and the jump affordance quote back, so it has to be
 * what the reader can see, not a private summary that says something else. Paths stay absolute here:
 * the entry is built before anyone knows where the session is standing, and no sentence of more than
 * one call contains a path anyway.
 */
export function runLabel(calls: readonly ToolCall[]): string {
  const segments = segmentsOf({ calls, cwd: '' })
  const first = segments[0]
  if (first === undefined) return ''
  if (!calls.some(settled)) return WORKING

  if (first.kind === 'alone') return first.read.reading.alone ?? first.read.reading.line

  const done = first.reads.filter((read) => settled(read.call))
  return done.length === 0 ? WORKING : sentenceOf(done)
}

export const WORKING = 'Working…'
