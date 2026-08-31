import { describe, expect, it } from 'bun:test'

import { ECallState } from '../../tool-runs'
import { measureOfSentence, segmentsOf, sentenceOf } from '../aggregate'
import { aCall, aShell, CWD } from './fixture'

const rowsOf = (calls: Parameters<typeof segmentsOf>[0]['calls']) =>
  segmentsOf({ calls, cwd: CWD }).map((segment) =>
    segment.kind === 'sentence'
      ? `${sentenceOf(segment.reads)}${measureOfSentence(segment.reads)}`
      : `${segment.read.reading.alone ?? segment.read.reading.line}${segment.repeats > 1 ? ` × ${segment.repeats}` : ''}`,
  )

const read = (path: string, lines: number) =>
  aCall({ name: 'read', input: { path: `${CWD}/${path}` }, output: { lines } })

const grep = (pattern: string, matches: number) =>
  aCall({
    name: 'grep',
    input: { pattern },
    output: { matches: Array.from({ length: matches }, (_unused, index) => `hit-${index}`) },
  })

describe('the sentence a run of gathering makes', () => {
  it('counts each clause and totals what the clause measures', () => {
    expect(rowsOf([read('a.ts', 10), read('b.ts', 20), grep('x', 3)])).toEqual([
      'Read 2 files, searched 1 time · 30 lines · 3 matches',
    ])
  })

  it('orders clauses by consequence rather than by which landed first', () => {
    expect(rowsOf([grep('x', 1), read('a.ts', 5)])).toEqual([
      'Read 1 file, searched 1 time · 5 lines · 1 match',
    ])
  })

  it('pulls a failure out of the sentence, so the row that broke says its own name', () => {
    const broken = aShell({ command: 'nixify', exitCode: 1 })

    expect(rowsOf([read('a.ts', 5), read('b.ts', 5), broken])).toEqual([
      'Read 2 files · 10 lines',
      'nixify',
    ])
  })

  it('breaks the sentence where the failure fell rather than hoisting it to either end', () => {
    const broken = aShell({ command: 'nixify', exitCode: 1 })

    expect(rowsOf([read('a.ts', 5), broken, read('b.ts', 5), grep('x', 2)])).toEqual([
      'Read a.ts',
      'nixify',
      'Read 1 file, searched 1 time · 5 lines · 2 matches',
    ])
  })

  it('leaves no failure for a measure to count, because none can join a sentence', () => {
    const broken = aShell({ command: 'nixify', exitCode: 1 })
    const segments = segmentsOf({ calls: [read('a.ts', 5), read('b.ts', 5), broken], cwd: CWD })
    const sentences = segments.filter((segment) => segment.kind === 'sentence')

    expect(sentences.flatMap((segment) => segment.reads).some((entry) => entry.reading.failed)).toBe(
      false,
    )
    expect(sentences.map((segment) => measureOfSentence(segment.reads))).toEqual([' · 10 lines'])
  })
})

describe('what does not join the sentence', () => {
  it('breaks the run where a named command fell, rather than reordering around it', () => {
    expect(
      rowsOf([
        read('a.ts', 5),
        aShell({ command: 'bunx tsc --noEmit' }),
        read('b.ts', 5),
      ]),
    ).toEqual(['Read a.ts', 'Typecheck clean', 'Read b.ts'])
  })

  it('gives a change its own row', () => {
    expect(rowsOf([read('a.ts', 5), aCall({ name: 'write', output: { path: `${CWD}/n.ts` } })])).toEqual([
      'Read a.ts',
      'Wrote n.ts',
    ])
  })

  it('collapses a command that repeated back to back', () => {
    const typecheck = () => aShell({ command: 'bunx tsc --noEmit' })

    expect(rowsOf([typecheck(), typecheck(), typecheck()])).toEqual(['Typecheck clean × 3'])
  })

  it('keeps two DIFFERENT results apart, because the second one is news', () => {
    expect(
      rowsOf([
        aShell({ command: 'bunx tsc --noEmit' }),
        aShell({ command: 'bunx tsc --noEmit', stdout: 'a.ts(1,1): error TS1: x', exitCode: 2 }),
      ]),
    ).toEqual(['Typecheck clean', 'Typecheck — 1 error'])
  })
})

describe('a group of one is not a group', () => {
  it('draws a lone gathered call as itself, with the words the model wrote', () => {
    expect(rowsOf([aShell({ command: 'bun test', description: 'Wait for the full suite' })])).toEqual([
      'Wait for the full suite',
    ])
  })

  it('gives a lone read a sentence rather than a bare path', () => {
    expect(rowsOf([read('src/ui/theme.ts', 210)])).toEqual(['Read src/ui/theme.ts'])
  })

  it('still makes a sentence of two', () => {
    expect(rowsOf([read('a.ts', 1), read('b.ts', 1)])).toEqual(['Read 2 files · 2 lines'])
  })
})

describe('a run still happening', () => {
  it('keeps a pending call out of the sentence it has not contributed to yet', () => {
    const segments = segmentsOf({
      calls: [read('a.ts', 5), aCall({ name: 'read', state: ECallState.Pending })],
      cwd: CWD,
    })
    const first = segments[0]
    if (first?.kind !== 'sentence') throw new Error('the reads make one sentence')

    expect(sentenceOf(first.reads.filter((entry) => entry.call.state !== ECallState.Pending))).toBe(
      'Read 1 file',
    )
  })
})
