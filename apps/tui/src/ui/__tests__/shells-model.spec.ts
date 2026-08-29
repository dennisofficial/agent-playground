import { describe, expect, it } from 'bun:test'

import { EKilledBy, EShellStatus, toShellId, type ShellSnapshot } from '@dltech/atlas-harness'

import {
  EOutputScroll,
  moveShellSelection,
  openShells,
  outputRows,
  outputScrollCommand,
  runningCount,
  selectShell,
  selectedShell,
  shellCommandLabel,
  shellStateLabel,
} from '../shells-model'

const shell = (over: Omit<Partial<ShellSnapshot>, 'shellId'> & { shellId: string }): ShellSnapshot => ({
  command: 'bun test',
  status: EShellStatus.Running,
  pid: 4242,
  startedAt: '2026-08-27T12:00:00.000Z',
  lastOutputAt: '2026-08-27T12:00:00.000Z',
  totalCharacters: 0,
  awaitingInput: false,
  ...over,
  shellId: toShellId(over.shellId),
})

const running = (id: string) => shell({ shellId: id })

const done = (id: string, exitCode = 0) =>
  shell({ shellId: id, status: EShellStatus.Exited, exitCode })

describe('opening the shells panel', () => {
  it('lands on the first running shell rather than the first one ever started', () => {
    const shells = [done('bash_1'), running('bash_2'), running('bash_3')]

    expect(openShells({ shells })).toEqual({ index: 1 })
  })

  it('lands on the shell it was asked for, even a finished one', () => {
    const shells = [running('bash_1'), done('bash_2')]

    expect(openShells({ shells, shellId: 'bash_2' })).toEqual({ index: 1 })
  })

  it('falls back to the top when the shell it was asked for is gone', () => {
    expect(openShells({ shells: [done('bash_1')], shellId: 'bash_9' })).toEqual({ index: 0 })
  })

  it('opens on nothing when there is nothing to open', () => {
    expect(openShells({ shells: [] })).toEqual({ index: 0 })
  })
})

describe('moving through the shells', () => {
  it('walks down and back up', () => {
    const state = moveShellSelection({ state: { index: 0 }, count: 3, delta: 1 })

    expect(state).toEqual({ index: 1 })
    expect(moveShellSelection({ state, count: 3, delta: -1 })).toEqual({ index: 0 })
  })

  it('stops at the ends rather than wrapping, so a held key does not cycle', () => {
    expect(moveShellSelection({ state: { index: 2 }, count: 3, delta: 1 })).toEqual({ index: 2 })
    expect(moveShellSelection({ state: { index: 0 }, count: 3, delta: -1 })).toEqual({ index: 0 })
  })

  it('collapses to the top when there is nothing listed', () => {
    expect(moveShellSelection({ state: { index: 4 }, count: 0, delta: 1 })).toEqual({ index: 0 })
  })
})

describe('reading which shell is selected', () => {
  it('clamps an index past the end, so a shell list that shrank does not read undefined', () => {
    const shells = [running('bash_1')]

    expect(selectedShell({ state: { index: 7 }, shells })?.shellId).toBe(toShellId('bash_1'))
  })

  it('is undefined when nothing is listed', () => {
    expect(selectedShell({ state: { index: 0 }, shells: [] })).toBeUndefined()
  })

  it('selects by id', () => {
    const shells = [running('bash_1'), running('bash_2')]

    expect(selectShell({ shells, shellId: 'bash_2' })).toEqual({ index: 1 })
  })
})

describe('saying what a shell is doing', () => {
  it('calls a running one running', () => {
    expect(shellStateLabel(running('bash_1'))).toBe('running')
  })

  it('calls out one waiting on input, since that one will never finish', () => {
    expect(shellStateLabel(shell({ shellId: 'bash_1', awaitingInput: true }))).toBe('awaiting input')
  })

  it('names a failing exit code', () => {
    expect(shellStateLabel(done('bash_1', 3))).toBe('exit 3')
  })

  it('says done for a clean exit', () => {
    expect(shellStateLabel(done('bash_1'))).toBe('done')
  })

  it('says killed for one that was stopped', () => {
    expect(shellStateLabel(shell({ shellId: 'bash_1', status: EShellStatus.Killed }))).toBe('killed')
  })

  it('says when the kill was the developer', () => {
    expect(
      shellStateLabel(
        shell({ shellId: 'bash_1', status: EShellStatus.Killed, killedBy: EKilledBy.User }),
      ),
    ).toBe('killed by you')
  })

  it('says why an overflowed one was stopped', () => {
    expect(shellStateLabel(shell({ shellId: 'bash_1', status: EShellStatus.Overflowed }))).toContain(
      'too much output',
    )
  })

  it('counts only the running ones', () => {
    expect(runningCount([running('bash_1'), done('bash_2'), running('bash_3')])).toBe(2)
  })

  it('flattens a multi-line command onto one line for a sidebar row', () => {
    expect(shellCommandLabel('bun test \\\n  --watch')).toBe('bun test \\ --watch')
  })
})

describe('laying a shell tail out in the scrollback on offer', () => {
  it('keeps the newest lines when there are more than fit', () => {
    const text = ['one', 'two', 'three', 'four'].join('\n')

    expect(outputRows({ text, cells: 20, limit: 2 })).toEqual(['three', 'four'])
  })

  it('wraps a long line rather than clipping the end off it', () => {
    expect(outputRows({ text: 'abcdefgh', cells: 3, limit: 10 })).toEqual(['abc', 'def', 'gh'])
  })

  it('counts a wrapped line against the row budget', () => {
    expect(outputRows({ text: 'abcdefgh', cells: 3, limit: 2 })).toEqual(['def', 'gh'])
  })

  it('ignores the trailing newline a command leaves behind', () => {
    expect(outputRows({ text: 'done\n', cells: 20, limit: 4 })).toEqual(['done'])
  })

  it('turns tabs into spaces, since a tab measures as one cell and prints as many', () => {
    expect(outputRows({ text: 'a\tb', cells: 20, limit: 4 })).toEqual(['a  b'])
  })

  it('returns nothing when there are no rows to fill', () => {
    expect(outputRows({ text: 'anything', cells: 20, limit: 0 })).toEqual([])
  })

  it('returns nothing for no output, so the panel can say so in words', () => {
    expect(outputRows({ text: '', cells: 20, limit: 4 })).toEqual([])
    expect(outputRows({ text: '\n\n', cells: 20, limit: 4 })).toEqual([])
  })
})

describe('reading the scrollback keys', () => {
  it('pages with the keys a pager pages with', () => {
    expect(outputScrollCommand({ name: 'pageup' })).toEqual({
      kind: EOutputScroll.Pages,
      amount: -1,
    })
    expect(outputScrollCommand({ name: 'pagedown' })).toEqual({
      kind: EOutputScroll.Pages,
      amount: 1,
    })
  })

  it('walks to either end of what was kept', () => {
    expect(outputScrollCommand({ name: 'home' })).toEqual({ kind: EOutputScroll.ToStart })
    expect(outputScrollCommand({ name: 'end' })).toEqual({ kind: EOutputScroll.ToEnd })
  })

  it('creeps a few lines on a shifted arrow', () => {
    expect(outputScrollCommand({ name: 'up', shift: true })).toEqual({
      kind: EOutputScroll.Lines,
      amount: -3,
    })
    expect(outputScrollCommand({ name: 'down', shift: true })).toEqual({
      kind: EOutputScroll.Lines,
      amount: 3,
    })
  })

  it('leaves a bare arrow alone, since that one walks the shells', () => {
    expect(outputScrollCommand({ name: 'up' })).toBeNull()
    expect(outputScrollCommand({ name: 'down' })).toBeNull()
  })

  it('claims nothing else', () => {
    expect(outputScrollCommand({ name: 'k' })).toBeNull()
    expect(outputScrollCommand({ name: 'escape' })).toBeNull()
    expect(outputScrollCommand({})).toBeNull()
  })
})
