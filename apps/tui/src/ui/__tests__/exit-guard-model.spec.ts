import { toShellId } from '@dltech/atlas-harness'
import { describe, expect, it } from 'bun:test'

import {
  DETACH_NOTE,
  EExitChoice,
  EXIT_GUARD_OPTIONS,
  exitGuardRow,
  moveSelection,
  openExitGuard,
  resolve,
  selectedOption,
} from '../exit-guard-model'

const opened = () => openExitGuard()

const at = (choice: EExitChoice): number =>
  EXIT_GUARD_OPTIONS.findIndex((option) => option.choice === choice)

describe('exit guard options', () => {
  it('offers stopping, detaching and staying in that order', () => {
    expect(EXIT_GUARD_OPTIONS.map((option) => option.choice)).toEqual([
      EExitChoice.StopAndExit,
      EExitChoice.Detach,
      EExitChoice.Stay,
    ])
  })

  it('disables detaching and says it is coming', () => {
    const detach = EXIT_GUARD_OPTIONS[at(EExitChoice.Detach)]

    expect(detach?.enabled).toBe(false)
    expect(detach?.note).toBe(DETACH_NOTE)
  })

  it('enables stopping and staying with no note', () => {
    const enabled = EXIT_GUARD_OPTIONS.filter((option) => option.enabled)

    expect(enabled.map((option) => option.choice)).toEqual([
      EExitChoice.StopAndExit,
      EExitChoice.Stay,
    ])
    expect(enabled.every((option) => option.note === undefined)).toBe(true)
  })
})

describe('opening the exit guard', () => {
  it('selects the first enabled option', () => {
    expect(resolve(opened())).toBe(EExitChoice.StopAndExit)
  })

  it('carries nothing but the selection', () => {
    expect(opened()).toEqual({ selected: at(EExitChoice.StopAndExit) })
  })
})

describe('moving the selection', () => {
  it('skips the disabled option going down', () => {
    const moved = moveSelection({ state: opened(), delta: 1 })

    expect(moved.selected).toBe(at(EExitChoice.Stay))
  })

  it('skips the disabled option going up', () => {
    const bottom = moveSelection({ state: opened(), delta: 1 })
    const moved = moveSelection({ state: bottom, delta: -1 })

    expect(moved.selected).toBe(at(EExitChoice.StopAndExit))
  })

  it('never lands on the disabled option however far it steps', () => {
    const landed = [-3, -2, -1, 1, 2, 3].map(
      (delta) => moveSelection({ state: opened(), delta }).selected,
    )

    expect(landed).not.toContain(at(EExitChoice.Detach))
  })

  it('clamps at the bottom rather than wrapping', () => {
    const bottom = moveSelection({ state: opened(), delta: 1 })
    const past = moveSelection({ state: bottom, delta: 1 })

    expect(past.selected).toBe(at(EExitChoice.Stay))
  })

  it('clamps at the top rather than wrapping', () => {
    const past = moveSelection({ state: opened(), delta: -1 })

    expect(past.selected).toBe(at(EExitChoice.StopAndExit))
  })

  it('stands still on a zero delta', () => {
    const state = opened()

    expect(moveSelection({ state, delta: 0 })).toBe(state)
  })
})

describe('resolving a choice', () => {
  it('returns the option the selection sits on', () => {
    expect(resolve(moveSelection({ state: opened(), delta: 1 }))).toBe(EExitChoice.Stay)
  })

  it('returns nothing when the selection sits on a disabled option', () => {
    expect(resolve({ selected: at(EExitChoice.Detach) })).toBeNull()
  })

  it('returns nothing when the selection sits off the end', () => {
    expect(resolve({ selected: EXIT_GUARD_OPTIONS.length })).toBeNull()
  })

  it('reports the selected option itself', () => {
    expect(selectedOption(opened())?.choice).toBe(EExitChoice.StopAndExit)
    expect(selectedOption({ selected: -1 })).toBeUndefined()
  })
})

describe('rows for running shells', () => {
  it('labels a shell with its description', () => {
    const row = exitGuardRow({
      shellId: toShellId('bash_1'),
      command: 'bun run dev',
      description: 'dev server',
    })

    expect(row).toEqual({ shellId: 'bash_1', label: 'dev server' })
  })

  it('falls back to the command when there is no description', () => {
    const row = exitGuardRow({ shellId: toShellId('bash_2'), command: 'bun run dev' })

    expect(row.label).toBe('bun run dev')
  })

  it('falls back to the command when the description is only whitespace', () => {
    const row = exitGuardRow({
      shellId: toShellId('bash_3'),
      command: 'bun  test\n--watch',
      description: '  ',
    })

    expect(row.label).toBe('bun test --watch')
  })
})
