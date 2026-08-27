import { describe, expect, it } from 'bun:test'

import { EShellStatus } from '@dltech/atlas-core'

import { durableEntries } from '../durable-entries'
import { isExpandable } from '../expandable'
import { EEntryKind, type BackgroundShellEndedEntry } from '../transcript-model'
import { log } from './fixture'

const shellEnded = (over: Record<string, unknown> = {}) =>
  ({
    type: 'background-shell-ended' as const,
    shellId: 'bash_1',
    command: 'bun test',
    description: 'Run full TUI suite',
    status: EShellStatus.Exited,
    exitCode: 0,
    output: '261 pass, 0 fail\n',
    droppedCharacters: 0,
    remainingCharacters: 0,
    ...over,
  })

const onlyShellEntry = (events: Parameters<typeof durableEntries>[0]): BackgroundShellEndedEntry => {
  const entry = durableEntries(events).find(
    (candidate): candidate is BackgroundShellEndedEntry =>
      candidate.kind === EEntryKind.BackgroundShellEnded,
  )
  if (entry === undefined) throw new Error('no background shell entry was projected')
  return entry
}

describe('a background shell ending in the transcript', () => {
  it('is its own entry rather than something the operator said', () => {
    const entries = durableEntries(log([shellEnded()]))

    expect(entries).toHaveLength(1)
    expect(entries[0]?.kind).toBe(EEntryKind.BackgroundShellEnded)
  })

  it('reads as an event naming the job, not as the command that ran', () => {
    expect(onlyShellEntry(log([shellEnded()])).text).toBe(
      'Background shell "Run full TUI suite" completed (exit code 0)',
    )
  })

  it('falls back to the command when the shell was never named', () => {
    expect(onlyShellEntry(log([shellEnded({ description: undefined })])).text).toBe(
      'Background shell `bun test` completed (exit code 0)',
    )
  })

  it('says a kill was a kill', () => {
    const entry = onlyShellEntry(
      log([shellEnded({ status: EShellStatus.Killed, exitCode: undefined })]),
    )

    expect(entry.text).toBe('Background shell "Run full TUI suite" was killed')
    expect(entry.failed).toBe(false)
  })

  it('marks a non-zero exit as failed, so the line can be read at a glance', () => {
    const entry = onlyShellEntry(log([shellEnded({ exitCode: 2 })]))

    expect(entry.text).toBe('Background shell "Run full TUI suite" failed (exit code 2)')
    expect(entry.failed).toBe(true)
  })

  it('keeps the output for the fold rather than putting it on the line', () => {
    const entry = onlyShellEntry(log([shellEnded()]))

    expect(entry.text).not.toContain('261 pass')
    expect(entry.output).toBe('261 pass, 0 fail\n')
    expect(isExpandable(entry)).toBe(true)
  })

  it('does not offer a fold when the shell printed nothing', () => {
    expect(isExpandable(onlyShellEntry(log([shellEnded({ output: '' })])))).toBe(false)
  })

  it('never folds into the message a human typed beside it', () => {
    const entries = durableEntries(
      log([{ type: 'user-said', text: 'Again' }, shellEnded(), { type: 'user-said', text: 'go on' }]),
    )

    expect(entries.map((entry) => entry.kind)).toEqual([
      EEntryKind.OperatorSaid,
      EEntryKind.BackgroundShellEnded,
      EEntryKind.OperatorSaid,
    ])
  })
})
