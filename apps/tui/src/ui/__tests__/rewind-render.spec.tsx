import { describe, expect, it } from 'bun:test'
import React from 'react'

import { HEADING, Rewind } from '../components/rewind'
import { cellsOf } from '../hint-layout'
import { grammarsReady } from '../markdown/__tests__/harness'
import {
  COMPACT_LABEL,
  CURRENT_LABEL,
  ERewindPointKind,
  ERewindVerb,
  NOTHING_CHANGES,
  VERB_LABEL,
  type RewindPoint,
  type RewindState,
} from '../rewind-model'
import { glyph } from '../theme'
import { frameOf } from './transcript-fixture'

await grammarsReady()

const WIDTH = 48

const NARROW = 30

const said = (args: { seq: number; text: string }): RewindPoint => ({
  kind: ERewindPointKind.Said,
  ...args,
})

const compacted = (args: { seq: number; replaced: number }): RewindPoint => ({
  kind: ERewindPointKind.Compacted,
  text: '',
  ...args,
})

const LONG = 'tighten the loop so a denied tool does not cost the whole branch of work'

const THREE: readonly RewindPoint[] = [
  said({ seq: 1, text: 'rewrite the loop' }),
  said({ seq: 3, text: 'now cache the prefix' }),
  said({ seq: 5, text: 'and steer a running turn' }),
]

const MANY: readonly RewindPoint[] = Array.from({ length: 12 }, (_unused, index) =>
  said({ seq: index + 1, text: `said number ${index + 1}` }),
)

const WATERMARK: readonly RewindPoint[] = [
  said({ seq: 1, text: 'rewrite the loop' }),
  compacted({ seq: 3, replaced: 4 }),
  said({ seq: 4, text: 'now cache the prefix' }),
]

const stateOf = (args: {
  points?: readonly RewindPoint[]
  index: number
  verb?: ERewindVerb
}): RewindState => ({
  points: args.points ?? THREE,
  index: args.index,
  verb: args.verb ?? null,
})

async function rowsOf(args: { state: RewindState; width?: number }): Promise<string[]> {
  const width = args.width ?? WIDTH
  const frame = await frameOf(
    <Rewind width={width} state={args.state} onPick={() => {}} onDismiss={() => {}} />,
    width,
  )
  return frame.split('\n')
}

const rowWith = (rows: readonly string[], needle: string): string =>
  rows.find((row) => row.includes(needle)) ?? ''

const written = (rows: readonly string[]): string[] =>
  rows.map((row) => row.trimEnd()).filter((row) => row.replaceAll('│', '').trim().length > 0)

const prose = (rows: readonly string[]): string =>
  written(rows)
    .map((row) => row.replaceAll('│', '').trim())
    .join(' ')

describe('the panel it opens with', () => {
  it('says what it is and what it will not touch', async () => {
    const rows = await rowsOf({ state: stateOf({ index: 2 }) })
    expect(rowWith(rows, HEADING)).not.toBe('')
    expect(prose(rows)).toContain('Files are left as they are.')
  })

  it('claims nothing about restoring code', async () => {
    const rows = await rowsOf({ state: stateOf({ index: 2 }) })
    for (const lie of ['code restore', 'No code changes', 'restore the code']) {
      expect(rowWith(rows, lie)).toBe('')
    }
  })

  it('lists every message and marks the selected one once', async () => {
    const rows = await rowsOf({ state: stateOf({ index: 1 }) })
    for (const point of THREE) expect(rowWith(rows, point.text)).not.toBe('')

    const marked = rows.filter((row) => row.includes(glyph.selected))
    expect(marked).toHaveLength(1)
    expect(marked[0]).toContain('now cache the prefix')
  })

  it('wraps a long message over lines instead of cutting it off', async () => {
    const rows = written(await rowsOf({ state: stateOf({ points: [said({ seq: 1, text: LONG })], index: 0 }) }))
    expect(rowWith(rows, 'tighten the loop')).not.toBe('')
    expect(rowWith(rows, 'branch of work')).not.toBe('')
    expect(rowWith(rows, 'tighten the loop')).not.toBe(rowWith(rows, 'branch of work'))
  })

  it('spends no more than its line budget on one row', async () => {
    const flood = Array.from({ length: 40 }, (_unused, index) => `word${index + 1}`).join(' ')
    const rows = written(await rowsOf({ state: stateOf({ points: [said({ seq: 1, text: flood })], index: 0 }) }))
    expect(rowWith(rows, 'word1')).not.toBe('')
    expect(rowWith(rows, '…')).not.toBe('')
    expect(rowWith(rows, 'word40')).toBe('')
  })

  it('says beneath each row what rewinding to it discards', async () => {
    const rows = await rowsOf({ state: stateOf({ index: 2 }) })
    expect(rowWith(rows, '2 later messages discarded')).not.toBe('')
    expect(rowWith(rows, '1 later message discarded')).not.toBe('')
    expect(rowWith(rows, 'only the replies to it discarded')).not.toBe('')
  })

  it('offers the row that changes nothing, and says so', async () => {
    const rows = await rowsOf({ state: stateOf({ index: 3 }) })
    const current = rowWith(rows, CURRENT_LABEL)
    expect(current).toContain(glyph.selected)
    expect(rowWith(rows, NOTHING_CHANGES)).not.toBe('')
  })

  it('names the operation on a compaction row and leads with what it undoes', async () => {
    const rows = await rowsOf({ state: stateOf({ points: WATERMARK, index: 1 }) })
    expect(rowWith(rows, COMPACT_LABEL)).toContain(glyph.selected)
    expect(prose(rows)).toContain('compaction undone, 1 later message discarded')
  })

  it('counts what the window is hiding at each end', async () => {
    const newest = await rowsOf({ state: stateOf({ points: MANY, index: 11 }) })
    expect(rowWith(newest, '↑ 7 more above')).not.toBe('')

    const oldest = await rowsOf({ state: stateOf({ points: MANY, index: 0 }) })
    expect(rowWith(oldest, '↓ 7 more below')).not.toBe('')
  })

  it('offers no verb until a point is settled', async () => {
    const rows = await rowsOf({ state: stateOf({ index: 1 }) })
    for (const label of Object.values(VERB_LABEL)) expect(rowWith(rows, label)).toBe('')
  })

  it('walks the choice forward rather than committing it', async () => {
    const rows = written(await rowsOf({ state: stateOf({ index: 1 }) }))
    expect(rows.at(-1)).toBe('│  Enter to continue · Esc to cancel')
  })

  it('keeps every row inside the overlay, wide or narrow', async () => {
    for (const width of [NARROW, WIDTH]) {
      const rows = await rowsOf({ state: stateOf({ index: 0 }), width })
      for (const row of rows) expect(cellsOf(row)).toBeLessThanOrEqual(width)
    }
  })

  it('keeps the way out when the row is too narrow for both hints', async () => {
    const rows = written(await rowsOf({ state: stateOf({ index: 0 }), width: NARROW }))
    expect(rows.at(-1)).toContain('Esc to cancel')
  })
})

describe('choosing what to do at that message', () => {
  const committing = stateOf({ index: 1, verb: ERewindVerb.ToHere })

  it('keeps the chosen message on screen and drops the rest of the list', async () => {
    const rows = await rowsOf({ state: committing })
    expect(rowWith(rows, 'now cache the prefix')).not.toBe('')
    expect(rowWith(rows, 'rewrite the loop')).toBe('')
    expect(rowWith(rows, CURRENT_LABEL)).toBe('')
  })

  it('offers every verb this point can act on, with what each would take', async () => {
    const rows = await rowsOf({ state: committing })
    expect(rowWith(rows, VERB_LABEL[ERewindVerb.ToHere])).toContain('1 lost')
    expect(rowWith(rows, VERB_LABEL[ERewindVerb.SummariseUpTo])).toContain('1 before')
    expect(rowWith(rows, VERB_LABEL[ERewindVerb.SummariseFrom])).toContain('2 from here')
  })

  it('spells out what the highlighted verb costs, and that it is final', async () => {
    const rows = await rowsOf({ state: committing })
    expect(rowWith(rows, glyph.warning)).toContain('1 later message')
    expect(prose(rows)).toContain(
      '1 later message and every reply are deleted, this one returns to the composer · no undo',
    )
  })

  it('says a summarisation deletes rows', async () => {
    const rows = await rowsOf({ state: stateOf({ index: 1, verb: ERewindVerb.SummariseUpTo }) })
    expect(prose(rows)).toContain(
      '1 earlier message and their replies become one summary · deletes rows · no undo',
    )
    expect(rowWith(rows, 'returns to the composer')).toBe('')
  })

  it('offers a compaction row only the rewind that undoes it', async () => {
    const rows = await rowsOf({
      state: stateOf({ points: WATERMARK, index: 1, verb: ERewindVerb.ToHere }),
    })
    expect(rowWith(rows, VERB_LABEL[ERewindVerb.ToHere])).not.toBe('')
    expect(rowWith(rows, VERB_LABEL[ERewindVerb.SummariseUpTo])).toBe('')
    expect(rowWith(rows, VERB_LABEL[ERewindVerb.SummariseFrom])).toBe('')
    expect(prose(rows)).toContain('the compaction is undone and 1 later message')
  })

  it('offers a way back out that is not the destructive one', async () => {
    const rows = written(await rowsOf({ state: committing }))
    expect(rows.at(-1)).toBe('│  Enter to confirm · Esc to go back')
  })

  it('keeps every row inside the overlay while committing', async () => {
    for (const width of [NARROW, WIDTH]) {
      const rows = await rowsOf({ state: committing, width })
      for (const row of rows) expect(cellsOf(row)).toBeLessThanOrEqual(width)
    }
  })
})
