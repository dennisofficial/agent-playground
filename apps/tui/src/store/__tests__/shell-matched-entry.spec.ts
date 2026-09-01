import { describe, expect, it } from 'bun:test'

import type { Event } from '@dltech/atlas-core'

import { durableEntries } from '../durable-entries'
import { isExpandable } from '../expandable'
import { EEntryKind, type BackgroundShellMatchedEntry } from '../transcript-model'
import { log } from './fixture'

const shellMatched = (over: Record<string, unknown> = {}) =>
  ({
    type: 'background-shell-matched' as const,
    shellId: 'bash_1',
    command: 'bun test',
    description: 'Run full TUI suite',
    pattern: '(fail|error)',
    lines: '12 fail\n',
    matchCount: 1,
    ...over,
  })

const onlyMatchedEntry = (events: readonly Event[]): BackgroundShellMatchedEntry => {
  const entry = durableEntries({ events }).find(
    (candidate): candidate is BackgroundShellMatchedEntry =>
      candidate.kind === EEntryKind.BackgroundShellMatched,
  )
  if (entry === undefined) throw new Error('no background shell match was projected')
  return entry
}

describe('a background shell watch match in the transcript', () => {
  it('is its own entry rather than something the operator said', () => {
    const entries = durableEntries({ events: log([shellMatched()]) })

    expect(entries).toHaveLength(1)
    expect(entries[0]?.kind).toBe(EEntryKind.BackgroundShellMatched)
  })

  it('reads as progress on a running job, not as an ending', () => {
    expect(onlyMatchedEntry(log([shellMatched()])).text).toBe(
      'Background shell "Run full TUI suite" matched 1 line and is still running',
    )
  })

  it('counts more than one match in the plural', () => {
    expect(onlyMatchedEntry(log([shellMatched({ matchCount: 7 })])).text).toBe(
      'Background shell "Run full TUI suite" matched 7 lines and is still running',
    )
  })

  it('falls back to the command when the shell was never named', () => {
    expect(onlyMatchedEntry(log([shellMatched({ description: undefined })])).text).toBe(
      'Background shell `bun test` matched 1 line and is still running',
    )
  })

  it('says a disarmed watch stopped watching without saying the shell stopped', () => {
    const text = onlyMatchedEntry(log([shellMatched({ watchDisarmed: true })])).text

    expect(text).toBe(
      'Background shell "Run full TUI suite" matched 1 line and is still running, but stopped watching',
    )
  })

  it('keeps the matched lines for the fold rather than putting them on the line', () => {
    const entry = onlyMatchedEntry(log([shellMatched({ lines: '12 fail\n13 fail\n' })]))

    expect(entry.text).not.toContain('12 fail')
    expect(entry.output).toBe('12 fail\n13 fail\n')
    expect(entry.shellId).toBe('bash_1')
    expect(isExpandable(entry)).toBe(true)
  })

  it('does not offer a fold when the match carried no lines', () => {
    expect(isExpandable(onlyMatchedEntry(log([shellMatched({ lines: '' })])))).toBe(false)
  })

  it('never folds into the message a human typed beside it', () => {
    const entries = durableEntries({
      events: log([
        { type: 'user-said', text: 'run it' },
        shellMatched(),
        { type: 'user-said', text: 'anything failing?' },
      ]),
    })

    expect(entries.map((entry) => entry.kind)).toEqual([
      EEntryKind.OperatorSaid,
      EEntryKind.BackgroundShellMatched,
      EEntryKind.OperatorSaid,
    ])
  })
})
