import { EGroupState, type ToolGroup } from './tool-groups'

export enum EAuthor {
  Operator = 'operator',
  Model = 'model',
}

export enum EEntryKind {
  OperatorSaid = 'operator-said',
  ModelSaid = 'model-said',
  ModelThought = 'model-thought',
  ToolsRan = 'tools-ran',
  HistoryCompacted = 'history-compacted',
  BackgroundShellEnded = 'background-shell-ended',
  TurnEnded = 'turn-ended',
}

export type OperatorSaidEntry = {
  kind: EEntryKind.OperatorSaid
  author: EAuthor.Operator
  key: string
  text: string
  said: readonly string[]
  steer: boolean
  skills: readonly string[]
}

export type ModelSaidEntry = {
  kind: EEntryKind.ModelSaid
  author: EAuthor.Model
  key: string
  text: string
  streaming: boolean
  interrupted: boolean
}

export type ModelThoughtEntry = {
  kind: EEntryKind.ModelThought
  author: EAuthor.Model
  key: string
  text: string
  streaming: boolean
  heldOpen: boolean
  interrupted: boolean
}

export type ToolsRanEntry = {
  kind: EEntryKind.ToolsRan
  author: EAuthor.Model
  key: string
  text: string
  streaming: boolean
  interrupted: boolean
  group: ToolGroup
}

export const toolsRanEntry = (group: ToolGroup): ToolsRanEntry => ({
  kind: EEntryKind.ToolsRan,
  author: EAuthor.Model,
  key: group.key,
  text: group.label,
  streaming: group.state === EGroupState.Live,
  interrupted: false,
  group,
})

export type HistoryCompactedEntry = {
  kind: EEntryKind.HistoryCompacted
  author: EAuthor.Model
  key: string
  text: string
  compactedEntries: number
}

export type BackgroundShellEndedEntry = {
  kind: EEntryKind.BackgroundShellEnded
  author: EAuthor.Model
  key: string
  text: string
  shellId: string
  output: string
  failed: boolean
}

export type TurnEndedEntry = {
  kind: EEntryKind.TurnEnded
  author: EAuthor.Model
  key: string
  text: string
  durationMs: number
  outputTokens: number
  endedAt: string
  interrupted: boolean
}

export type TranscriptEntry =
  | OperatorSaidEntry
  | ModelSaidEntry
  | ModelThoughtEntry
  | ToolsRanEntry
  | HistoryCompactedEntry
  | BackgroundShellEndedEntry
  | TurnEndedEntry

export type StepFailure = { message: string | null }

export type TranscriptModel = {
  entries: readonly TranscriptEntry[]
  isEmpty: boolean
  streaming: boolean
  failure: StepFailure | null
}

export const EMPTY_TRANSCRIPT: TranscriptModel = {
  entries: [],
  isEmpty: true,
  streaming: false,
  failure: null,
}
