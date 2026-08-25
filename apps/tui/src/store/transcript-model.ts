export enum EAuthor {
  Operator = 'operator',
  Model = 'model',
}

export enum EEntryKind {
  OperatorSaid = 'operator-said',
  ModelSaid = 'model-said',
  ModelThought = 'model-thought',
}

export type OperatorSaidEntry = {
  kind: EEntryKind.OperatorSaid
  author: EAuthor.Operator
  key: string
  text: string
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
  interrupted: boolean
}

export type TranscriptEntry = OperatorSaidEntry | ModelSaidEntry | ModelThoughtEntry

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
