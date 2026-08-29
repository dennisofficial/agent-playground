import {
  EAuthor,
  EEntryKind,
  type ModelThoughtEntry,
  type TranscriptEntry,
} from './transcript-model'

export enum EThinkingVisibility {
  Keep = 'keep',
  Stream = 'stream',
  Hidden = 'hidden',
}

export const SHIPPED_THINKING = EThinkingVisibility.Keep

export function thinkingVisibilityOf(value: string): EThinkingVisibility {
  if (value === EThinkingVisibility.Stream) return EThinkingVisibility.Stream
  if (value === EThinkingVisibility.Hidden) return EThinkingVisibility.Hidden
  return EThinkingVisibility.Keep
}

const THOUGHT_SEAM = '\n\n'

const isThought = (entry: TranscriptEntry | undefined): entry is ModelThoughtEntry =>
  entry?.kind === EEntryKind.ModelThought

function foldedThought(args: {
  first: ModelThoughtEntry
  rest: readonly ModelThoughtEntry[]
}): ModelThoughtEntry {
  const run = [args.first, ...args.rest]

  return {
    kind: EEntryKind.ModelThought,
    author: EAuthor.Model,
    key: args.first.key,
    text: run
      .map((entry) => entry.text.trim())
      .filter((text) => text.length > 0)
      .join(THOUGHT_SEAM),
    streaming: run.some((entry) => entry.streaming),
    heldOpen: false,
    interrupted: run[run.length - 1]?.interrupted ?? false,
  }
}

function foldedAdjacentThoughts(entries: readonly TranscriptEntry[]): TranscriptEntry[] {
  const folded: TranscriptEntry[] = []
  let open: ModelThoughtEntry | null = null
  let rest: ModelThoughtEntry[] = []

  const flush = (): void => {
    if (open !== null) folded.push(foldedThought({ first: open, rest }))
    open = null
    rest = []
  }

  for (const entry of entries) {
    if (isThought(entry)) {
      if (open === null) open = entry
      else rest.push(entry)
      continue
    }

    flush()
    folded.push(entry)
  }

  flush()
  return folded
}

function heldOpenIndex(folded: readonly TranscriptEntry[]): number {
  for (let index = folded.length - 1; index >= 0; index -= 1) {
    const entry = folded[index]
    if (isThought(entry)) return index
    if (entry?.kind !== EEntryKind.ToolsRan) return -1
  }

  return -1
}

export function foldThoughts(args: {
  entries: readonly TranscriptEntry[]
  visibility: EThinkingVisibility
}): TranscriptEntry[] {
  if (args.visibility === EThinkingVisibility.Hidden) {
    return args.entries.filter((entry) => !isThought(entry))
  }

  const folded = foldedAdjacentThoughts(args.entries)
  if (args.visibility === EThinkingVisibility.Keep) return folded

  const held = heldOpenIndex(folded)

  return folded.flatMap((entry, index): TranscriptEntry[] => {
    if (!isThought(entry) || entry.streaming) return [entry]
    return index === held ? [{ ...entry, heldOpen: true }] : []
  })
}
