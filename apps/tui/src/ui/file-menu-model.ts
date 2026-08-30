import {
  activeFilePathQuery,
  browseCandidates,
  completedFilePath,
  completedMentionPath,
  splitMentionQuery,
  type DirectoryEntry,
  type MentionQuery,
} from '@dltech/atlas-core'

import { menuWindow, movedIndex, MENU_ROWS, type MenuWindow } from './menu-model'

export const FILE_MENU_ROWS = MENU_ROWS

export const MAX_FILE_MATCHES = 50

export type FileMenuState = {
  index: number
  directory: string
  fragment: string
  matches: readonly DirectoryEntry[]
}

export function mentionQueryOf(text: string): MentionQuery | null {
  const query = activeFilePathQuery(text)
  return query === null ? null : splitMentionQuery(query)
}

export function openFileMenu(args: {
  query: MentionQuery
  entries: readonly DirectoryEntry[]
}): FileMenuState | null {
  const matches = browseCandidates({
    entries: args.entries,
    fragment: args.query.fragment,
  }).slice(0, MAX_FILE_MATCHES)

  if (matches.length === 0) return null

  return { index: 0, directory: args.query.directory, fragment: args.query.fragment, matches }
}

export function moveFileSelection(args: { state: FileMenuState; delta: number }): FileMenuState {
  const index = movedIndex({
    index: args.state.index,
    count: args.state.matches.length,
    delta: args.delta,
  })

  return index === args.state.index ? args.state : { ...args.state, index }
}

export function selectedEntry(state: FileMenuState): DirectoryEntry | null {
  return state.matches[state.index] ?? null
}

export const pathOfEntry = (args: { directory: string; entry: DirectoryEntry }): string =>
  `${args.directory}${args.entry.name}${args.entry.isDirectory ? '/' : ''}`

export function completedMention(args: { text: string; state: FileMenuState }): string | null {
  const entry = selectedEntry(args.state)
  if (entry === null) return null

  const completed = completedMentionPath({ directory: args.state.directory, entry })

  return completedFilePath({ text: args.text, path: completed.path, settled: completed.settled })
}

export function fileMenuWindow(args: {
  state: FileMenuState
  rows: number
}): MenuWindow<DirectoryEntry> {
  return menuWindow({ entries: args.state.matches, index: args.state.index, rows: args.rows })
}
