import type { Event } from '@dltech/atlas-core'

export const REWIND_ROWS = 5

export const ROW_LINE_BUDGET = 2

const PREVIEW_CHARACTER_LIMIT = 240

export const COMPACT_LABEL = '/compact'

export const CURRENT_LABEL = '(current)'

export const NOTHING_CHANGES = 'nothing changes'

export const NO_UNDO = 'no undo'

export enum ERewindVerb {
  ToHere = 'to-here',
  SummariseUpTo = 'summarise-up-to',
  SummariseFrom = 'summarise-from',
  Fork = 'fork',
}

export enum ERewindPointKind {
  Said = 'said',
  Compacted = 'compacted',
}

export type RewindPoint =
  | { kind: ERewindPointKind.Said; seq: number; text: string }
  | { kind: ERewindPointKind.Compacted; seq: number; text: string; replaced: number }

export type RewindState = {
  points: readonly RewindPoint[]
  index: number
  verb: ERewindVerb | null
}

export type RewindChoice = { point: RewindPoint; verb: ERewindVerb }

export type RewindWindow = { start: number; visible: readonly RewindPoint[]; below: number }

type Said = Extract<Event, { type: 'user-said' }>

type Compacted = Extract<Event, { type: 'history-compacted' }>

const wasSaid = (event: Event): event is Said => event.type === 'user-said'

const wasCompaction = (event: Event): event is Compacted => event.type === 'history-compacted'

const isSaid = (point: RewindPoint): boolean => point.kind === ERewindPointKind.Said

const clamped = (args: { value: number; count: number }): number =>
  Math.min(Math.max(0, args.value), Math.max(0, args.count - 1))

const pointOf = (event: Event): RewindPoint[] => {
  if (wasSaid(event)) return [{ kind: ERewindPointKind.Said, seq: event.seq, text: event.text }]

  if (wasCompaction(event))
    return [
      { kind: ERewindPointKind.Compacted, seq: event.seq, text: '', replaced: event.replaced },
    ]

  return []
}

export function openRewind(args: { events: readonly Event[] }): RewindState | null {
  const points = args.events.flatMap(pointOf)
  if (points.length === 0) return null

  return { points, index: points.length - 1, verb: null }
}

export function selectedPoint(state: RewindState): RewindPoint | null {
  return state.points[state.index] ?? null
}

export const isCurrentRow = (state: RewindState): boolean => state.index >= state.points.length

const saidIn = (args: { points: readonly RewindPoint[]; from: number; to: number }): number =>
  args.points.slice(Math.max(0, args.from), Math.max(0, args.to)).filter(isSaid).length

const saidAfter = (args: { points: readonly RewindPoint[]; index: number }): number =>
  saidIn({ points: args.points, from: args.index + 1, to: args.points.length })

const saidBefore = (args: { points: readonly RewindPoint[]; index: number }): number =>
  saidIn({ points: args.points, from: 0, to: args.index })

const saidFrom = (args: { points: readonly RewindPoint[]; index: number }): number =>
  saidIn({ points: args.points, from: args.index, to: args.points.length })

const saidThrough = (args: { points: readonly RewindPoint[]; index: number }): number =>
  saidIn({ points: args.points, from: 0, to: args.index + 1 })

export function verbsFor(args: { state: RewindState }): readonly ERewindVerb[] {
  const { points, index } = args.state
  const point = selectedPoint(args.state)
  if (point === null) return []
  if (point.kind === ERewindPointKind.Compacted) return [ERewindVerb.ToHere]

  return [
    ERewindVerb.ToHere,
    ...(saidBefore({ points, index }) > 0 ? [ERewindVerb.SummariseUpTo] : []),
    ...(saidFrom({ points, index }) > 1 ? [ERewindVerb.SummariseFrom] : []),
    ERewindVerb.Fork,
  ]
}

function movedVerb(args: {
  state: RewindState
  verb: ERewindVerb
  steps: number
}): RewindState {
  const { state } = args
  const verbs = verbsFor({ state })
  const at = clamped({ value: verbs.indexOf(args.verb) + args.steps, count: verbs.length })
  const verb = verbs[at]

  if (verb === undefined || verb === args.verb) return state

  return { ...state, verb }
}

export function moveSelection(args: { state: RewindState; delta: number }): RewindState {
  const steps = Math.trunc(args.delta)
  if (steps === 0) return args.state

  const { state } = args
  if (state.verb !== null) return movedVerb({ state, verb: state.verb, steps })

  const index = clamped({ value: state.index + steps, count: state.points.length + 1 })
  if (index === state.index) return state

  return { ...state, index }
}

export function chooseVerb(args: { state: RewindState; verb: ERewindVerb }): RewindState {
  if (!verbsFor({ state: args.state }).includes(args.verb)) return args.state

  return { ...args.state, verb: args.verb }
}

export function clearVerb(args: { state: RewindState }): RewindState {
  if (args.state.verb === null) return args.state

  return { ...args.state, verb: null }
}

export function resolve(state: RewindState): RewindChoice | null {
  const point = selectedPoint(state)
  if (point === null || state.verb === null) return null

  return { point, verb: state.verb }
}

export function messagesAffected(args: { state: RewindState; verb: ERewindVerb }): number {
  const { points, index } = args.state

  if (args.verb === ERewindVerb.SummariseUpTo) return saidBefore({ points, index })
  if (args.verb === ERewindVerb.SummariseFrom) return saidFrom({ points, index })

  return saidAfter({ points, index })
}

const plural = (args: { count: number; noun: string }): string =>
  `${args.count} ${args.noun}${args.count === 1 ? '' : 's'}`

export function pointLabel(args: { point: RewindPoint }): string {
  if (args.point.kind === ERewindPointKind.Compacted) return COMPACT_LABEL

  return args.point.text.slice(0, PREVIEW_CHARACTER_LIMIT).replace(/\s+/g, ' ').trim()
}

export function pointConsequence(args: { state: RewindState; index: number }): string {
  const { points } = args.state
  const point = points[args.index]
  if (point === undefined) return NOTHING_CHANGES

  const later = saidAfter({ points, index: args.index })
  const discarded =
    later === 0
      ? 'nothing else discarded'
      : `${plural({ count: later, noun: 'later message' })} discarded`

  if (point.kind === ERewindPointKind.Compacted) return `compaction undone, ${discarded}`
  if (later === 0) return 'only the replies to it discarded'

  return discarded
}

export const VERB_LABEL: Readonly<Record<ERewindVerb, string>> = {
  [ERewindVerb.ToHere]: 'rewind to here',
  [ERewindVerb.SummariseUpTo]: 'summarise up to here',
  [ERewindVerb.SummariseFrom]: 'summarise from here',
  [ERewindVerb.Fork]: 'fork from here',
}

export function verbTally(args: { state: RewindState; verb: ERewindVerb }): string {
  if (args.verb === ERewindVerb.Fork) {
    const { points, index } = args.state
    return `${saidThrough({ points, index })} kept`
  }

  const count = messagesAffected(args)
  if (args.verb === ERewindVerb.SummariseUpTo) return `${count} before`
  if (args.verb === ERewindVerb.SummariseFrom) return `${count} from here`

  return `${count} lost`
}

function rewindConsequence(args: { state: RewindState; count: number }): string {
  const point = selectedPoint(args.state)
  const discarded =
    args.count === 0
      ? 'nothing else is deleted'
      : `${plural({ count: args.count, noun: 'later message' })} and every reply are deleted`

  if (point?.kind === ERewindPointKind.Compacted)
    return `the compaction is undone and ${discarded}`

  if (args.count === 0)
    return 'every reply after this is deleted, this message returns to the composer'

  return `${discarded}, this one returns to the composer`
}

export function verbConsequence(args: { state: RewindState; verb: ERewindVerb }): string {
  if (args.verb === ERewindVerb.Fork)
    return 'a new conversation continues from here with everything up to it copied · this one is untouched'

  const count = messagesAffected(args)

  if (args.verb === ERewindVerb.SummariseUpTo)
    return `${plural({ count, noun: 'earlier message' })} and their replies become one summary · deletes rows`

  if (args.verb === ERewindVerb.SummariseFrom)
    return `${plural({ count, noun: 'message' })} from here and their replies become one summary · deletes rows`

  return rewindConsequence({ state: args.state, count })
}

export function rewindWindow(args: { state: RewindState; rows: number }): RewindWindow {
  const rows = Math.max(1, Math.trunc(args.rows))
  const count = args.state.points.length
  if (count <= rows) return { start: 0, visible: args.state.points, below: 0 }

  const start = Math.min(Math.max(0, args.state.index - rows + 1), count - rows)
  return {
    start,
    visible: args.state.points.slice(start, start + rows),
    below: count - start - rows,
  }
}
