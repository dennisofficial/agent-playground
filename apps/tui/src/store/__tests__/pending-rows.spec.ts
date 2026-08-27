import { describe, expect, it } from 'bun:test'

import { EShellStatus } from '@dltech/atlas-core'
import { toShellId, type ShellSnapshot } from '@dltech/atlas-harness'

import { EPendingKind, pendingRows } from '../pending-rows'

const typed = (id: string, text: string, taken = false) => ({ id, text, taken })

const snapshot = (over: Partial<ShellSnapshot> = {}): ShellSnapshot =>
  ({
    shellId: toShellId('bash_1'),
    command: 'bun test',
    description: 'Run full TUI suite',
    status: EShellStatus.Exited,
    exitCode: 0,
    pid: 4_242,
    startedAt: '2026-08-27T12:00:00.000Z',
    lastOutputAt: '2026-08-27T12:00:01.000Z',
    totalCharacters: 18,
    awaitingInput: false,
    ...over,
  }) as ShellSnapshot

describe('what waits under the working indicator', () => {
  it('is nothing at all when neither a message nor an ending is waiting', () => {
    expect(pendingRows({ messages: [], notices: [] })).toEqual([])
  })

  it('queues a shell ending behind the messages a human typed', () => {
    const rows = pendingRows({ messages: [typed('p1', 'and the fixtures')], notices: [snapshot()] })

    expect(rows.map((row) => row.kind)).toEqual([
      EPendingKind.Operator,
      EPendingKind.BackgroundShell,
    ])
  })

  it('reads a queued ending the same way the transcript will', () => {
    const rows = pendingRows({ messages: [], notices: [snapshot()] })

    expect(rows[0]).toEqual({
      kind: EPendingKind.BackgroundShell,
      id: 'shell-ended-bash_1',
      text: 'Background shell "Run full TUI suite" completed (exit code 0)',
      failed: false,
    })
  })

  it('carries no take-back or taken flag, because nobody sent it', () => {
    const row = pendingRows({ messages: [], notices: [snapshot()] })[0]

    expect(row === undefined ? null : 'taken' in row).toBe(false)
  })

  it('marks a failure so the queued line is not read as good news', () => {
    const rows = pendingRows({ messages: [], notices: [snapshot({ exitCode: 2 })] })

    expect(rows[0]?.kind === EPendingKind.BackgroundShell && rows[0].failed).toBe(true)
  })

  it('keys each ending by its shell, so two waiting endings stay distinct', () => {
    const rows = pendingRows({
      messages: [],
      notices: [snapshot(), snapshot({ shellId: toShellId('bash_2'), description: 'Watch the docs' })],
    })

    expect(rows.map((row) => row.id)).toEqual(['shell-ended-bash_1', 'shell-ended-bash_2'])
  })
})
