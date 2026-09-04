import { describe, expect, it } from 'bun:test'

import type { Event } from '@dltech/atlas-core'

import { durableEntries } from '../durable-entries'
import { isExpandable } from '../expandable'
import { EEntryKind, type BackgroundShellStillRunningEntry } from '../transcript-model'
import { log } from './fixture'

const shellStillRunning = (over: Record<string, unknown> = {}) =>
  ({
    type: 'background-shell-still-running' as const,
    shellId: 'bash_27',
    command: 'bash /tmp/cubic-poll-371.sh 43',
    description: 'Poll cubic round on head 43db0f7c',
    runningForMs: 806_000,
    silentForMs: 26_000,
    checkInMs: 300_000,
    tail: '40 pending no-check\n',
    ...over,
  })

const onlyStillRunningEntry = (events: readonly Event[]): BackgroundShellStillRunningEntry => {
  const entry = durableEntries({ events }).find(
    (candidate): candidate is BackgroundShellStillRunningEntry =>
      candidate.kind === EEntryKind.BackgroundShellStillRunning,
  )
  if (entry === undefined) throw new Error('no background shell check-in was projected')
  return entry
}

describe('a background shell check-in in the transcript', () => {
  it('is its own entry rather than something the operator said', () => {
    const entries = durableEntries({ events: log([shellStillRunning()]) })

    expect(entries).toHaveLength(1)
    expect(entries[0]?.kind).toBe(EEntryKind.BackgroundShellStillRunning)
  })

  it('reads as a check-in on a running job, not as an ending', () => {
    expect(onlyStillRunningEntry(log([shellStillRunning()])).text).toBe(
      'Background shell "Poll cubic round on head 43db0f7c" is still running after 13m 26s - a scheduled check-in, not an ending',
    )
  })

  it('falls back to the command when the shell was never named', () => {
    expect(onlyStillRunningEntry(log([shellStillRunning({ description: undefined })])).text).toBe(
      'Background shell `bash /tmp/cubic-poll-371.sh 43` is still running after 13m 26s - a scheduled check-in, not an ending',
    )
  })

  it('keeps the tail for the fold rather than putting it on the line', () => {
    const entry = onlyStillRunningEntry(log([shellStillRunning()]))

    expect(entry.text).not.toContain('40 pending no-check')
    expect(entry.output).toBe('40 pending no-check\n')
    expect(entry.shellId).toBe('bash_27')
    expect(isExpandable(entry)).toBe(true)
  })

  it('does not offer a fold when the shell has printed nothing', () => {
    expect(isExpandable(onlyStillRunningEntry(log([shellStillRunning({ tail: '' })])))).toBe(false)
  })

  it('never folds into the message a human typed beside it', () => {
    const entries = durableEntries({
      events: log([
        { type: 'user-said', text: 'how is the poll doing' },
        shellStillRunning(),
      ]),
    })

    expect(entries.map((entry) => entry.kind)).toEqual([
      EEntryKind.OperatorSaid,
      EEntryKind.BackgroundShellStillRunning,
    ])
  })
})
