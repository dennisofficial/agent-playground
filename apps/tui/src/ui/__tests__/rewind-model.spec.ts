import {
  ECompactionAnchor,
  stampEvent,
  toEventId,
  toRunId,
  toThreadId,
  type Event,
  type EventDraft,
} from '@dltech/atlas-core'
import { describe, expect, it } from 'bun:test'

import {
  chooseVerb,
  clearVerb,
  COMPACT_LABEL,
  ERewindPointKind,
  ERewindVerb,
  isCurrentRow,
  messagesAffected,
  moveSelection,
  NOTHING_CHANGES,
  openRewind,
  pointConsequence,
  pointLabel,
  resolve,
  rewindWindow,
  selectedPoint,
  verbConsequence,
  verbsFor,
  verbTally,
  type RewindPoint,
  type RewindState,
} from '../rewind-model'

const THREAD = toThreadId('rewinding')

const AT = '2026-08-27T00:00:00.000Z'

const stamped = (drafts: readonly EventDraft[]): Event[] =>
  drafts.map((draft, index) =>
    stampEvent({
      draft,
      envelope: {
        id: toEventId(`event-${index + 1}`),
        seq: index + 1,
        threadId: THREAD,
        runId: toRunId('run-1'),
        depth: 0,
        at: AT,
      },
    }),
  )

const answered = (text: string): EventDraft => ({
  type: 'assistant-said',
  parts: [{ type: 'text', text }],
})

const compaction: EventDraft = {
  type: 'history-compacted',
  anchor: ECompactionAnchor.Prefix,
  fromSeq: 1,
  throughSeq: 2,
  summary: 'they asked for the loop and got it',
  replaced: 2,
}

const EXCHANGES: readonly EventDraft[] = [
  { type: 'user-said', text: 'first' },
  answered('answered first'),
  { type: 'user-said', text: 'second' },
  answered('answered second'),
  { type: 'user-said', text: 'third' },
]

const opened = (drafts: readonly EventDraft[] = EXCHANGES): RewindState => {
  const state = openRewind({ events: stamped(drafts) })
  if (state === null) throw new Error('there was nothing to rewind to')
  return state
}

const said = (args: { seq: number; text: string }): RewindPoint => ({
  kind: ERewindPointKind.Said,
  ...args,
})

const compacted = (args: { seq: number; replaced: number }): RewindPoint => ({
  kind: ERewindPointKind.Compacted,
  text: '',
  ...args,
})

const stateOf = (args: {
  points?: readonly RewindPoint[]
  index: number
  verb?: ERewindVerb
}): RewindState => ({
  points: args.points ?? THREE,
  index: args.index,
  verb: args.verb ?? null,
})

const THREE: readonly RewindPoint[] = [
  said({ seq: 1, text: 'first' }),
  said({ seq: 3, text: 'second' }),
  said({ seq: 5, text: 'third' }),
]

const WATERMARK: readonly [RewindPoint, RewindPoint] = [
  compacted({ seq: 2, replaced: 4 }),
  said({ seq: 3, text: 'after' }),
]

const AROUND: readonly RewindPoint[] = [
  said({ seq: 1, text: 'first' }),
  compacted({ seq: 2, replaced: 4 }),
  said({ seq: 3, text: 'second' }),
]

const THEN: RewindState = { points: THREE, index: 1, verb: null }

describe('what the picker offers', () => {
  it('offers nothing when there is no message and no compaction', () => {
    expect(openRewind({ events: [] })).toBeNull()
    expect(openRewind({ events: stamped([answered('unprompted')]) })).toBeNull()
  })

  it('offers what the operator said and every compaction, oldest first', () => {
    const state = opened([
      { type: 'user-said', text: 'first' },
      answered('answered first'),
      compaction,
      { type: 'user-said', text: 'second' },
    ])

    expect(state.points).toEqual([
      said({ seq: 1, text: 'first' }),
      compacted({ seq: 3, replaced: 2 }),
      said({ seq: 4, text: 'second' }),
    ])
  })

  it('gives a compaction no composer text, because nobody typed a summary', () => {
    expect(selectedPoint(opened([compaction]))?.text).toBe('')
  })

  it('starts on the most recent point', () => {
    expect(opened().index).toBe(2)
    expect(opened().verb).toBeNull()
  })

  it('keeps the whole message, so it can go back into the composer intact', () => {
    const long = 'x'.repeat(4000)
    expect(selectedPoint(opened([{ type: 'user-said', text: long }]))?.text).toBe(long)
  })
})

describe('moving through the rows', () => {
  it('walks back in time on a negative delta and stops at the oldest', () => {
    expect(moveSelection({ state: opened(), delta: -1 }).index).toBe(1)
    expect(moveSelection({ state: opened(), delta: -9 }).index).toBe(0)
  })

  it('walks down onto the row that changes nothing, and stops there', () => {
    const moved = moveSelection({ state: stateOf({ index: 0 }), delta: 9 })
    expect(moved.index).toBe(3)
    expect(isCurrentRow(moved)).toBe(true)
    expect(moveSelection({ state: moved, delta: 1 })).toBe(moved)
  })

  it('leaves the state alone on a delta of nothing', () => {
    expect(moveSelection({ state: THEN, delta: 0 })).toBe(THEN)
  })
})

describe('the row that changes nothing', () => {
  const current = stateOf({ index: 3 })

  it('selects no point, offers no verb, and says it costs nothing', () => {
    expect(selectedPoint(current)).toBeNull()
    expect(verbsFor({ state: current })).toEqual([])
    expect(resolve({ ...current, verb: ERewindVerb.ToHere })).toBeNull()
    expect(pointConsequence({ state: current, index: 3 })).toBe(NOTHING_CHANGES)
  })
})

describe('which verbs a point can offer', () => {
  it('will not summarise up to the oldest point, where there is nothing before it', () => {
    expect(verbsFor({ state: stateOf({ index: 0 }) })).toEqual([
      ERewindVerb.ToHere,
      ERewindVerb.SummariseFrom,
      ERewindVerb.Fork,
    ])
  })

  it('will not summarise from the most recent point, where it would summarise one message', () => {
    expect(verbsFor({ state: stateOf({ index: 2 }) })).toEqual([
      ERewindVerb.ToHere,
      ERewindVerb.SummariseUpTo,
      ERewindVerb.Fork,
    ])
  })

  it('offers all four in the middle', () => {
    expect(verbsFor({ state: stateOf({ index: 1 }) })).toEqual([
      ERewindVerb.ToHere,
      ERewindVerb.SummariseUpTo,
      ERewindVerb.SummariseFrom,
      ERewindVerb.Fork,
    ])
  })

  it('offers only the rewind on a compaction, which is the row that undoes it', () => {
    expect(verbsFor({ state: stateOf({ points: WATERMARK, index: 0 }) })).toEqual([
      ERewindVerb.ToHere,
    ])
  })

  it('counts messages, not watermarks, when deciding there is something to summarise', () => {
    expect(verbsFor({ state: stateOf({ points: WATERMARK, index: 1 }) })).toEqual([
      ERewindVerb.ToHere,
      ERewindVerb.Fork,
    ])
  })

  it('offers a fork on anything the operator said, because a fork deletes nothing', () => {
    for (const index of [0, 1, 2]) {
      expect(verbsFor({ state: stateOf({ index }) })).toContain(ERewindVerb.Fork)
    }
  })
})

describe('the two stages', () => {
  it('moves into the verb stage and back out again', () => {
    const chosen = chooseVerb({ state: opened(), verb: ERewindVerb.ToHere })
    expect(chosen.verb).toBe(ERewindVerb.ToHere)
    expect(chosen.index).toBe(2)
    expect(clearVerb({ state: chosen }).verb).toBeNull()
  })

  it('refuses a verb this point does not offer', () => {
    const state = stateOf({ index: 0 })
    expect(chooseVerb({ state, verb: ERewindVerb.SummariseUpTo })).toBe(state)
  })

  it('moves down the verbs, not down the points, and stops at the last on offer', () => {
    const middle = stateOf({ index: 1, verb: ERewindVerb.ToHere })
    const moved = moveSelection({ state: middle, delta: 1 })
    expect(moved.verb).toBe(ERewindVerb.SummariseUpTo)
    expect(moved.index).toBe(1)
    expect(moveSelection({ state: middle, delta: 9 }).verb).toBe(ERewindVerb.Fork)
  })

  it('resolves to nothing until both halves are chosen', () => {
    expect(resolve(opened())).toBeNull()
    expect(
      resolve(chooseVerb({ state: stateOf({ index: 1 }), verb: ERewindVerb.SummariseUpTo })),
    ).toEqual({ point: said({ seq: 3, text: 'second' }), verb: ERewindVerb.SummariseUpTo })
  })
})

describe('how many messages a verb would take', () => {
  const affected = (args: {
    points?: readonly RewindPoint[]
    index: number
    verb: ERewindVerb
  }): number =>
    messagesAffected({
      state: stateOf({ ...(args.points ? { points: args.points } : {}), index: args.index }),
      verb: args.verb,
    })

  it('counts what a rewind leaves behind, past the one it hands back', () => {
    expect(affected({ index: 0, verb: ERewindVerb.ToHere })).toBe(2)
    expect(affected({ index: 2, verb: ERewindVerb.ToHere })).toBe(0)
  })

  it('counts the messages either side of the point for the two summaries', () => {
    expect(affected({ index: 2, verb: ERewindVerb.SummariseUpTo })).toBe(2)
    expect(affected({ index: 1, verb: ERewindVerb.SummariseFrom })).toBe(2)
  })

  it('does not count a compaction watermark as a message', () => {
    expect(affected({ points: AROUND, index: 0, verb: ERewindVerb.ToHere })).toBe(1)
  })

  it('tallies a fork by what the new conversation keeps, since it discards nothing', () => {
    expect(verbTally({ state: stateOf({ index: 1 }), verb: ERewindVerb.Fork })).toBe('2 kept')
    expect(verbTally({ state: stateOf({ index: 0 }), verb: ERewindVerb.Fork })).toBe('1 kept')
  })
})

describe('what a row says it will cost', () => {
  it('counts the messages a rewind to that row discards', () => {
    expect(pointConsequence({ state: stateOf({ index: 0 }), index: 0 })).toBe(
      '2 later messages discarded',
    )
    expect(pointConsequence({ state: stateOf({ index: 1 }), index: 1 })).toBe(
      '1 later message discarded',
    )
  })

  it('says what is lost on the newest row, where no message follows it', () => {
    expect(pointConsequence({ state: stateOf({ index: 2 }), index: 2 })).toBe(
      'only the replies to it discarded',
    )
  })

  it('leads with the compaction it undoes', () => {
    expect(pointConsequence({ state: stateOf({ points: WATERMARK, index: 0 }), index: 0 })).toBe(
      'compaction undone, 1 later message discarded',
    )
    expect(pointConsequence({ state: stateOf({ points: [WATERMARK[0]], index: 0 }), index: 0 })).toBe(
      'compaction undone, nothing else discarded',
    )
  })
})

describe('what a verb says it will do', () => {
  it('names the composer for a rewind and says a summary deletes rows', () => {
    const state = stateOf({ index: 1 })
    expect(verbConsequence({ state, verb: ERewindVerb.ToHere })).toContain(
      'returns to the composer',
    )
    for (const verb of [ERewindVerb.SummariseUpTo, ERewindVerb.SummariseFrom]) {
      expect(verbConsequence({ state, verb })).toContain('one summary · deletes rows')
    }
  })

  it('leads a rewind onto a compaction with the compaction it undoes', () => {
    expect(
      verbConsequence({ state: stateOf({ points: WATERMARK, index: 0 }), verb: ERewindVerb.ToHere }),
    ).toBe('the compaction is undone and 1 later message and every reply are deleted')
  })

  it('promises a fork leaves this conversation untouched', () => {
    expect(verbConsequence({ state: stateOf({ index: 1 }), verb: ERewindVerb.Fork })).toBe(
      'a new conversation continues from here with everything up to it copied · this one is untouched',
    )
  })
})

describe('labelling a row', () => {
  it('flattens a message typed over several lines and caps a pasted trace', () => {
    expect(pointLabel({ point: said({ seq: 1, text: 'fix\n\n  the   loop\t' }) })).toBe(
      'fix the loop',
    )
    expect(pointLabel({ point: said({ seq: 1, text: 'y'.repeat(9000) }) }).length).toBeLessThan(300)
  })

  it('names the operation on a compaction row rather than pretending it was typed', () => {
    expect(pointLabel({ point: compacted({ seq: 2, replaced: 4 }) })).toBe(COMPACT_LABEL)
  })
})

describe('the window of rows the overlay can show', () => {
  const MANY: readonly RewindPoint[] = Array.from({ length: 12 }, (_unused, index) =>
    said({ seq: index + 1, text: `said ${index + 1}` }),
  )

  it('shows every point when they all fit, with nothing hidden', () => {
    expect(rewindWindow({ state: stateOf({ index: 2 }), rows: 5 })).toEqual({
      start: 0,
      visible: THREE,
      below: 0,
    })
  })

  it('keeps the selection in view and counts what is hidden at each end', () => {
    const newest = rewindWindow({ state: stateOf({ points: MANY, index: 11 }), rows: 4 })
    expect(newest.start).toBe(8)
    expect(newest.below).toBe(0)

    const oldest = rewindWindow({ state: stateOf({ points: MANY, index: 0 }), rows: 4 })
    expect(oldest.start).toBe(0)
    expect(oldest.below).toBe(8)
  })
})
