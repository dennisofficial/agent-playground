import { transcriptOfRange, type Event } from '@dltech/atlas-core'

export enum ERenamed {
  Renamed = 'renamed',
  Empty = 'empty',
  Declined = 'declined',
}

export type Renaming =
  | { type: ERenamed.Renamed; name: string }
  | { type: ERenamed.Empty }
  | { type: ERenamed.Declined }

const OPENING_CHARACTER_LIMIT = 300
const RECENT_CHARACTER_LIMIT = 1500
const ELISION = '\n…\n'

export function sessionDigest(events: readonly Event[]): string {
  const last = events.at(-1)
  if (last === undefined) return ''

  const transcript = transcriptOfRange({ events, throughSeq: last.seq, proseOnly: true })
  if (transcript.length <= OPENING_CHARACTER_LIMIT + RECENT_CHARACTER_LIMIT) return transcript

  const opening = transcript.slice(0, OPENING_CHARACTER_LIMIT)
  const recent = transcript.slice(-RECENT_CHARACTER_LIMIT)
  return `${opening}${ELISION}${recent}`
}
