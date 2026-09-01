import {
  ETriage,
  eventsOfType,
  type ERiskDimension,
  type Event,
  type EventOfType,
} from '@dltech/atlas-core'

type Judged = EventOfType<'classifier-judged'>

export type ClassifierFold = {
  pauses: number
  turns: number
  topDimension: ERiskDimension | null
  quietedCalls: number
  judgeUnreachable: boolean
}

const judgedRows = (events: readonly Event[]): Judged[] =>
  eventsOfType({ events, type: 'classifier-judged' })

const sinceLastTurn = (events: readonly Event[]): readonly Event[] => {
  const opened = events.findLastIndex((event) => event.type === 'user-said')
  return opened === -1 ? events : events.slice(opened)
}

const askedFor = (row: Judged): boolean => row.wouldAsk === true

const wentUnanswered = (row: Judged): boolean => row.triage === ETriage.Consult && !row.consulted

const dimensionsOf = (row: Judged): readonly ERiskDimension[] =>
  row.judgedDimension === undefined ? row.dimensions : [row.judgedDimension]

function commonest(rows: readonly Judged[]): ERiskDimension | null {
  const tally = new Map<ERiskDimension, number>()
  for (const row of rows) {
    for (const dimension of dimensionsOf(row)) {
      tally.set(dimension, (tally.get(dimension) ?? 0) + 1)
    }
  }

  let top: ERiskDimension | null = null
  let best = 0
  for (const [dimension, count] of tally) {
    if (count <= best) continue
    top = dimension
    best = count
  }

  return top
}

export function classifierFold({ events }: { events: readonly Event[] }): ClassifierFold | null {
  const rows = judgedRows(events)
  if (rows.length === 0) return null

  const paused = rows.filter(askedFor)

  return {
    pauses: paused.length,
    turns: eventsOfType({ events, type: 'user-said' }).length,
    topDimension: commonest(paused),
    quietedCalls: rows.filter((row) => row.fatigued === true).length,
    judgeUnreachable: judgedRows(sinceLastTurn(events)).some(wentUnanswered),
  }
}
