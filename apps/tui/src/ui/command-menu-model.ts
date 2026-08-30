import { activeQuery, commandCandidates, type CommandSpec } from '@dltech/atlas-core'

import { menuWindow, movedIndex, MENU_ROWS } from './menu-model'

export const COMMAND_MENU_ROWS = MENU_ROWS

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
  const index = movedIndex({
    index: args.state.index,
    count: args.state.matches.length,
    delta: args.delta,
  })

  return index === args.state.index ? args.state : { ...args.state, index }
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
  return menuWindow({ entries: args.state.matches, index: args.state.index, rows: args.rows })
}
