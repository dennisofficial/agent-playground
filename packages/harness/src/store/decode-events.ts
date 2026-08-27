import {
  eventBodySchema,
  stampDrafts,
  type Event,
  type EventDraft,
  type EventEnvelope,
} from '@dltech/atlas-core'

import { toEnvelope, type EventRow } from './event-row'

export enum EUnreadableReason {
  CorruptEnvelope = 'corrupt-envelope',
  MalformedJson = 'malformed-json',
  UnrecognizedBody = 'unrecognized-body',
}

export type UnreadableRow = {
  id: string
  seq: number
  threadId: string
  type: string
  reason: EUnreadableReason
  detail: string
}

export type DecodedLog = {
  events: Event[]
  unreadable: UnreadableRow[]
}

export function decodeEventRows(rows: readonly EventRow[]): DecodedLog {
  const drafts: EventDraft[] = []
  const envelopes: EventEnvelope[] = []
  const unreadable: UnreadableRow[] = []

  for (const row of rows) {
    const decoded = decodeRow(row)
    if ('reason' in decoded) {
      unreadable.push({
        id: row.id,
        seq: row.seq,
        threadId: row.threadId,
        type: row.type,
        reason: decoded.reason,
        detail: decoded.detail,
      })
      continue
    }
    drafts.push(decoded.draft)
    envelopes.push(decoded.envelope)
  }

  return { events: stampDrafts({ drafts, envelopes }), unreadable }
}

type Undecodable = { reason: EUnreadableReason; detail: string }

function decodeRow(row: EventRow): { draft: EventDraft; envelope: EventEnvelope } | Undecodable {
  let envelope: EventEnvelope
  try {
    envelope = toEnvelope(row)
  } catch (error) {
    return { reason: EUnreadableReason.CorruptEnvelope, detail: messageOf(error) }
  }

  const body = decodeBody(row.body)
  if ('reason' in body) return body
  return { draft: body.draft, envelope }
}

function decodeBody(body: string): { draft: EventDraft } | Undecodable {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch (error) {
    return { reason: EUnreadableReason.MalformedJson, detail: messageOf(error) }
  }

  const result = eventBodySchema.safeParse(parsed)
  if (!result.success) {
    return { reason: EUnreadableReason.UnrecognizedBody, detail: messageOf(result.error) }
  }
  return { draft: result.data }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
