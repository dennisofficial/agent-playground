import { describe, expect, it } from 'bun:test'

import { transcriptOfRange } from '../render-range'
import {
  called,
  compacted,
  denied,
  eventsFrom,
  loaded,
  replied,
  resulted,
  resultedWith,
  said,
} from './fixture'

describe('transcriptOfRange', () => {
  it('renders a spoken exchange as labelled turns', () => {
    const events = eventsFrom([said('build the parser'), replied('done')])

    expect(transcriptOfRange({ events, throughSeq: 2 })).toBe(
      'Operator: build the parser\nAtlas: done',
    )
  })

  it('stops at the watermark and leaves the tail out of the summariser prompt', () => {
    const events = eventsFrom([said('first'), replied('one'), said('second')])

    expect(transcriptOfRange({ events, throughSeq: 2 })).toBe('Operator: first\nAtlas: one')
  })

  it('folds a previous summary in, so a second compaction does not lose the first', () => {
    const events = eventsFrom([compacted(4, 'A parser was written.'), said('now the lexer')])

    expect(transcriptOfRange({ events, throughSeq: 2 })).toBe(
      'Summary of the conversation before this: A parser was written.\nOperator: now the lexer',
    )
  })

  it('renders a tool call and its result', () => {
    const events = eventsFrom([called('call-1'), resulted('call-1')])

    expect(transcriptOfRange({ events, throughSeq: 2 })).toBe(
      'Atlas called bash with {"command":"ls"}\nbash returned listed 3 files',
    )
  })

  it('renders a denial as a denial rather than as a result', () => {
    const events = eventsFrom([called('call-1'), denied('call-1')])

    expect(transcriptOfRange({ events, throughSeq: 2 })).toContain(
      'bash was denied: the operator said no',
    )
  })

  it('leaves loaded context out, because compaction keeps it rather than summarising it', () => {
    const events = eventsFrom([
      loaded('project-instructions', '/repo/CLAUDE.md', 'Never use as any.'),
      said('build the parser'),
    ])

    expect(transcriptOfRange({ events, throughSeq: 2 })).toBe('Operator: build the parser')
  })

  it('clips a tool payload so one huge result cannot dominate the summariser prompt', () => {
    const events = eventsFrom([resultedWith('call-1', 'x'.repeat(5_000))])

    expect(transcriptOfRange({ events, throughSeq: 1 }).length).toBeLessThan(1_000)
  })
})
