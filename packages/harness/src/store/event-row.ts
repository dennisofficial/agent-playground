import {
  eventBodySchema,
  toBranchId,
  toEventId,
  toRunId,
  type EventDraft,
  type EventEnvelope,
} from '@dltech/atlas-core'

import { contextDigestOf } from './context-digest'

export type EventRow = {
  id: string
  branchId: string
  seq: number
  runId: string
  parentRunId: string | null
  depth: number
  at: string
  type: string
  body: string
  contextSlot: string | null
  contextKey: string | null
  contextDigest: string | null
}

export class UnreadableWrite extends Error {
  constructor(args: { type: string; detail: string }) {
    super(`refusing to write a ${args.type} event Atlas could not read back: ${args.detail}`)
    this.name = 'UnreadableWrite'
  }
}

const bodyOf = (draft: EventDraft): string => {
  const body = JSON.stringify(draft)
  const readable = eventBodySchema.safeParse(JSON.parse(body))
  if (!readable.success) throw new UnreadableWrite({ type: draft.type, detail: readable.error.message })
  return body
}

export function toEventRow({ draft, envelope }: { draft: EventDraft; envelope: EventEnvelope }): EventRow {
  return {
    id: envelope.id,
    branchId: envelope.branchId,
    seq: envelope.seq,
    runId: envelope.runId,
    parentRunId: envelope.parentRunId ?? null,
    depth: envelope.depth,
    at: envelope.at,
    type: draft.type,
    body: bodyOf(draft),
    contextSlot: draft.type === 'context-loaded' ? draft.slot : null,
    contextKey: draft.type === 'context-loaded' ? draft.key : null,
    contextDigest: draft.type === 'context-loaded' ? contextDigestOf(draft.content) : null,
  }
}

export function toEnvelope(row: EventRow): EventEnvelope {
  return {
    id: toEventId(row.id),
    seq: row.seq,
    branchId: toBranchId(row.branchId),
    runId: toRunId(row.runId),
    depth: row.depth,
    at: row.at,
    ...(row.parentRunId === null ? {} : { parentRunId: toRunId(row.parentRunId) }),
  }
}
