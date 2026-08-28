import { activeQuery, commandCandidates, type CommandSpec } from '@dltech/atlas-core'

export const COMMAND_MENU_ROWS = 8

export type CommandMenuState = {
  index: number
  query: string
  matches: readonly CommandSpec[]
}

export type CommandMenuWindow = {
  start: number
  visible: readonly CommandSpec[]
}

export function openCommandMenu(args: {
  text: string
  specs: readonly CommandSpec[]
}): CommandMenuState | null {
  const query = activeQuery(args.text)
  if (query === null) return null

  const matches = commandCandidates({ text: args.text, specs: args.specs })
  if (matches.length === 0) return null

  return { index: 0, query, matches }
}

export function moveCommandSelection(args: {
  state: CommandMenuState
  delta: number
}): CommandMenuState {
  const count = args.state.matches.length
  if (count === 0) return args.state

  const steps = Math.trunc(args.delta)
  if (steps === 0) return args.state

  const wrapped = (((args.state.index + steps) % count) + count) % count
  return { ...args.state, index: wrapped }
}

export function selectedCommand(state: CommandMenuState): CommandSpec | null {
  return state.matches[state.index] ?? null
}

export function completedText(args: { text: string; spec: CommandSpec }): string {
  const query = activeQuery(args.text)
  if (query === null) return args.text

  const start = args.text.length - query.length - 1
  return `${args.text.slice(0, start)}/${args.spec.name} `
}

export function commandMenuWindow(args: {
  state: CommandMenuState
  rows: number
}): CommandMenuWindow {
  const rows = Math.max(1, Math.trunc(args.rows))
  const count = args.state.matches.length
  if (count <= rows) return { start: 0, visible: args.state.matches }

  const start = Math.min(Math.max(0, args.state.index - rows + 1), count - rows)
  return { start, visible: args.state.matches.slice(start, start + rows) }
}
