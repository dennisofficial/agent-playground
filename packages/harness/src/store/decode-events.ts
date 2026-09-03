import {
  eventBodySchema,
  stampEvent,
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

type CachedDecode = { event: Event; bytes: number } | { gap: UnreadableRow; bytes: number }

const DEFAULT_BYTE_CAP = 64 * 1024 * 1024

/**
 * Rows are immutable once written — nothing updates an Event body, only rewind deletes rows, and
 * deletes cannot serve stale decodes because every read re-fetches rows first. That makes the row
 * id a safe cache key, which is what lets a long session re-read its whole log per step boundary
 * without re-parsing and re-validating every body each time.
 */
export class EventDecodeCache {
  private readonly entries = new Map<string, CachedDecode>()
  private held = 0

  constructor(private readonly byteCap: number = DEFAULT_BYTE_CAP) {}

  lookup({ row }: { row: EventRow }): CachedDecode | undefined {
    if (row.id === '') return undefined

    const hit = this.entries.get(row.id)
    if (hit === undefined) return undefined

    this.entries.delete(row.id)
    this.entries.set(row.id, hit)
    return hit
  }

  keep({ row, decoded }: { row: EventRow; decoded: CachedDecode }): void {
    if (row.id === '' || this.entries.has(row.id)) return

    this.entries.set(row.id, decoded)
    this.held += decoded.bytes

    while (this.held > this.byteCap) {
      const oldest = this.entries.keys().next()
      if (oldest.done) break
      const dropped = this.entries.get(oldest.value)
      this.entries.delete(oldest.value)
      this.held -= dropped?.bytes ?? 0
    }
  }
}

export function decodeEventRows({
  rows,
  cache,
}: {
  rows: readonly EventRow[]
  cache?: EventDecodeCache | undefined
}): DecodedLog {
  const events: Event[] = []
  const unreadable: UnreadableRow[] = []

  for (const row of rows) {
    const cached = cache?.lookup({ row })
    if (cached !== undefined) {
      if ('gap' in cached) unreadable.push(cached.gap)
      else events.push(cached.event)
      continue
    }

    const decoded = decodeRow(row)
    if ('reason' in decoded) {
      const gap: UnreadableRow = {
        id: row.id,
        seq: row.seq,
        threadId: row.threadId,
        type: row.type,
        reason: decoded.reason,
        detail: decoded.detail,
      }
      unreadable.push(gap)
      cache?.keep({ row, decoded: { gap, bytes: row.body.length } })
      continue
    }

    const event = stampEvent({ draft: decoded.draft, envelope: decoded.envelope })
    events.push(event)
    cache?.keep({ row, decoded: { event, bytes: row.body.length } })
  }

  return { events, unreadable }
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
