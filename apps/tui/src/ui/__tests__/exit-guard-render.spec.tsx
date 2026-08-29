import { describe, expect, it } from 'bun:test'
import React from 'react'

import { ExitGuard, HEADING, SUBTITLE } from '../components/exit-guard'
import {
  DETACH_NOTE,
  EExitChoice,
  EXIT_GUARD_OPTIONS,
  type ExitGuardRow,
} from '../exit-guard-model'
import { glyph } from '../theme'
import { frameOf, mount } from './transcript-fixture'

const WIDTH = 80

const RUNNING_LABEL = 'Wait for TUI suite then report'

const RUNNING: readonly ExitGuardRow[] = [{ shellId: 'sh-1', label: RUNNING_LABEL }]

const guard = (over: { running?: readonly ExitGuardRow[]; selected?: number } = {}) => (
  <ExitGuard
    width={WIDTH}
    running={over.running ?? RUNNING}
    state={{ selected: over.selected ?? 0 }}
    overlay
    onPick={() => undefined}
    onDismiss={() => undefined}
  />
)

const rowsOf = (frame: string): string[] => frame.replace(/\n$/, '').split('\n')

const rowWith = (frame: string, text: string): string =>
  rowsOf(frame).find((row) => row.includes(text)) ?? ''

const labelOf = (choice: EExitChoice): string =>
  EXIT_GUARD_OPTIONS.find((option) => option.choice === choice)?.label ?? ''

describe('the exit guard when background work is still running', () => {
  it('says what is running and why it is asking', async () => {
    const frame = await frameOf(guard(), WIDTH)

    expect(frame).toContain(HEADING)
    expect(frame).toContain(SUBTITLE)
  })

  it('offers every way out of the question', async () => {
    const frame = await frameOf(guard(), WIDTH)

    for (const option of EXIT_GUARD_OPTIONS) expect(frame).toContain(option.label)
  })

  it('names the shell that would be stopped, tagged as one', async () => {
    const frame = await frameOf(guard(), WIDTH)

    expect(frame).toContain(RUNNING_LABEL)
    expect(rowWith(frame, RUNNING_LABEL)).toContain('shell')
  })

  it('lists every running shell, not only the first', async () => {
    const frame = await frameOf(
      guard({
        running: [
          { shellId: 'sh-1', label: RUNNING_LABEL },
          { shellId: 'sh-2', label: 'Tail the dev server' },
        ],
      }),
      WIDTH,
    )

    expect(frame).toContain(RUNNING_LABEL)
    expect(frame).toContain('Tail the dev server')
  })

  it('lists no work at all once the last shell has finished', async () => {
    const frame = await frameOf(guard({ running: [] }), WIDTH)

    expect(frame).toContain(HEADING)
    expect(frame).not.toContain('shell')
    expect(frame).not.toContain(RUNNING_LABEL)
  })

  it('advertises the option it cannot honour yet as unavailable', async () => {
    const frame = await frameOf(guard(), WIDTH)
    const detach = EXIT_GUARD_OPTIONS.find((option) => option.choice === EExitChoice.Detach)

    expect(detach?.enabled).toBe(false)
    expect(rowWith(frame, labelOf(EExitChoice.Detach))).toContain(`(${DETACH_NOTE})`)
  })

  it('leaves no empty brackets behind on the options that have no note', async () => {
    const frame = await frameOf(guard(), WIDTH)

    expect(rowWith(frame, labelOf(EExitChoice.StopAndExit))).not.toContain('(')
    expect(rowWith(frame, labelOf(EExitChoice.Stay))).not.toContain('(')
  })

  it('marks the selected option and nothing else', async () => {
    const frame = await frameOf(guard(), WIDTH)

    expect(rowWith(frame, labelOf(EExitChoice.StopAndExit))).toContain(glyph.selected)
    expect(rowWith(frame, labelOf(EExitChoice.Stay))).not.toContain(glyph.selected)
  })

  it('moves the mark when the selection moves', async () => {
    const frame = await frameOf(guard({ selected: EXIT_GUARD_OPTIONS.length - 1 }), WIDTH)

    expect(rowWith(frame, labelOf(EExitChoice.Stay))).toContain(glyph.selected)
    expect(rowWith(frame, labelOf(EExitChoice.StopAndExit))).not.toContain(glyph.selected)
  })

  it('numbers the options so they can be spoken about', async () => {
    const frame = await frameOf(guard(), WIDTH)

    EXIT_GUARD_OPTIONS.forEach((option, index) => {
      expect(rowWith(frame, option.label)).toContain(`${String(index + 1)}. ${option.label}`)
    })
  })

  it('says which keys answer the question', async () => {
    const frame = await frameOf(guard(), WIDTH)

    expect(frame).toContain('Enter to confirm')
    expect(frame).toContain('Esc to cancel')
  })

  it('rises from the bottom rather than floating over the middle', async () => {
    const rows = rowsOf(await frameOf(guard(), WIDTH))
    const edge = rows.findIndex((row) => row.trimEnd().startsWith('─'))

    expect(edge).toBeGreaterThan(rows.length / 2)
    expect(rows.slice(edge).some((row) => row.includes(HEADING))).toBe(true)
  })

  it('rules off the whole width, so it reads as a card and not a message', async () => {
    const rows = rowsOf(await frameOf(guard(), WIDTH))
    const edge = rows.find((row) => row.trimEnd().startsWith('─')) ?? ''

    expect(edge.trimEnd()).toHaveLength(WIDTH)
  })

  it('truncates a shell label too long for the card instead of spilling past it', async () => {
    const tail = 'THE-TAIL-NOBODY-SEES'
    const frame = await frameOf(
      guard({
        running: [{ shellId: 'sh-1', label: `${RUNNING_LABEL} ${'and on '.repeat(30)}${tail}` }],
      }),
      WIDTH,
    )

    expect(frame).toContain(RUNNING_LABEL)
    expect(frame).not.toContain(tail)
    expect(rowWith(frame, RUNNING_LABEL)).toContain('…')
    for (const row of rowsOf(frame)) expect(row.trimEnd().length).toBeLessThanOrEqual(WIDTH)
  })

  it('mounts at a narrow width without spilling', async () => {
    await expect(
      mount(
        <ExitGuard
          width={40}
          running={RUNNING}
          state={{ selected: 0 }}
          overlay
          onPick={() => undefined}
          onDismiss={() => undefined}
        />,
        40,
      ),
    ).resolves.toBeUndefined()
  })
})
