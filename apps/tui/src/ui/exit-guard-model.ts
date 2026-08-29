import type { ShellSnapshot } from '@dltech/atlas-harness'

import { shellNameLabel } from './shells-model'

export enum EExitChoice {
  StopAndExit = 'stop-and-exit',
  Detach = 'detach',
  Stay = 'stay',
}

export type ExitGuardRow = {
  shellId: string
  label: string
}

export type ExitGuardOption = {
  choice: EExitChoice
  label: string
  enabled: boolean
  note?: string | undefined
}

export type ExitGuardState = {
  selected: number
}

export const DETACH_NOTE = 'coming soon'

export const EXIT_GUARD_OPTIONS: readonly ExitGuardOption[] = Object.freeze([
  { choice: EExitChoice.StopAndExit, label: 'Exit and stop tasks', enabled: true },
  {
    choice: EExitChoice.Detach,
    label: 'Move to background and exit',
    enabled: false,
    note: DETACH_NOTE,
  },
  { choice: EExitChoice.Stay, label: 'Stay', enabled: true },
])

const FIRST_ENABLED = Math.max(
  0,
  EXIT_GUARD_OPTIONS.findIndex((option) => option.enabled),
)

export function exitGuardRow(
  shell: Pick<ShellSnapshot, 'shellId' | 'command' | 'description'>,
): ExitGuardRow {
  return { shellId: shell.shellId, label: shellNameLabel(shell) }
}

export function openExitGuard(): ExitGuardState {
  return { selected: FIRST_ENABLED }
}

export function selectedOption(state: ExitGuardState): ExitGuardOption | undefined {
  return EXIT_GUARD_OPTIONS[state.selected]
}

function nextEnabled(args: { from: number; step: number }): number {
  for (let at = args.from + args.step; at >= 0 && at < EXIT_GUARD_OPTIONS.length; at += args.step) {
    if (EXIT_GUARD_OPTIONS[at]?.enabled === true) return at
  }

  return args.from
}

function steppedSelection(args: { from: number; steps: number }): number {
  const step = args.steps < 0 ? -1 : 1
  let at = args.from

  for (let taken = 0; taken < Math.abs(args.steps); taken += 1) {
    at = nextEnabled({ from: at, step })
  }

  return at
}

export function moveSelection(args: { state: ExitGuardState; delta: number }): ExitGuardState {
  const steps = Math.trunc(args.delta)
  if (steps === 0) return args.state

  const selected = steppedSelection({ from: args.state.selected, steps })
  if (selected === args.state.selected) return args.state

  return { selected }
}

export function resolve(state: ExitGuardState): EExitChoice | null {
  const option = selectedOption(state)
  if (option === undefined || !option.enabled) return null

  return option.choice
}
