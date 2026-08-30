export type DirectoryEntry = { name: string; isDirectory: boolean }

export type MentionQuery = { directory: string; fragment: string }

export type CompletedMention = { path: string; settled: boolean }

const SEPARATOR = '/'

const HOME = '~'

export function splitMentionQuery(query: string): MentionQuery {
  if (query === HOME) return { directory: `${HOME}${SEPARATOR}`, fragment: '' }

  const cut = query.lastIndexOf(SEPARATOR)
  if (cut === -1) return { directory: '', fragment: query }

  return { directory: query.slice(0, cut + 1), fragment: query.slice(cut + 1) }
}

enum EEntryRank {
  Starts = 0,
  Contains = 1,
}

const rankOf = ({ name, fragment }: { name: string; fragment: string }): EEntryRank | null => {
  const lowered = name.toLowerCase()
  if (lowered.startsWith(fragment)) return EEntryRank.Starts
  if (lowered.includes(fragment)) return EEntryRank.Contains
  return null
}

const isHidden = (name: string): boolean => name.startsWith('.')

export function browseCandidates(args: {
  entries: readonly DirectoryEntry[]
  fragment: string
}): readonly DirectoryEntry[] {
  const fragment = args.fragment.toLowerCase()
  const wantsHidden = fragment.startsWith('.')

  const ranked = args.entries.flatMap((entry) => {
    if (isHidden(entry.name) && !wantsHidden) return []

    if (wantsHidden) {
      const starts = entry.name.toLowerCase().startsWith(fragment)
      return starts ? [{ entry, rank: EEntryRank.Starts }] : []
    }

    const rank = fragment === '' ? EEntryRank.Starts : rankOf({ name: entry.name, fragment })
    return rank === null ? [] : [{ entry, rank }]
  })

  return ranked
    .sort((left, right) => {
      if (left.rank !== right.rank) return left.rank - right.rank
      if (left.entry.isDirectory !== right.entry.isDirectory) return left.entry.isDirectory ? -1 : 1
      return left.entry.name.localeCompare(right.entry.name)
    })
    .map((one) => one.entry)
}

export function completedMentionPath(args: {
  directory: string
  entry: DirectoryEntry
}): CompletedMention {
  const spelled = `${args.directory}${args.entry.name}`

  return args.entry.isDirectory
    ? { path: `${spelled}${SEPARATOR}`, settled: false }
    : { path: spelled, settled: true }
}
