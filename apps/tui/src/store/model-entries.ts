import { EAuthor, EEntryKind, type TranscriptEntry } from './transcript-model'

export type ModelRun = { key: string; text: string; isReasoning: boolean }

export function modelEntries(args: {
  runs: readonly ModelRun[]
  streaming: boolean
  interruptedAtEnd: boolean
}): TranscriptEntry[] {
  return args.runs.map((run, index) => {
    const shared = {
      author: EAuthor.Model,
      key: run.key,
      text: run.text,
      streaming: args.streaming,
      interrupted: args.interruptedAtEnd && index === args.runs.length - 1,
    } as const

    return run.isReasoning
      ? { kind: EEntryKind.ModelThought, ...shared }
      : { kind: EEntryKind.ModelSaid, ...shared }
  })
}
