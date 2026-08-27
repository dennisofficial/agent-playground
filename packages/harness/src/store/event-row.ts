import {
  toBranchId,
  toEventId,
  toRunId,
  type EventDraft,
  type EventEnvelope,
} from '@dltech/atlas-core'

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
    body: JSON.stringify(draft),
    contextSlot: draft.type === 'context-loaded' ? draft.slot : null,
    contextKey: draft.type === 'context-loaded' ? draft.key : null,
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
