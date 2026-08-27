import type { EventDraft } from '../../events/body'
import type { Event } from '../../events/envelope'
import { toBranchId, toCallId, toEventId, toRunId } from '../../events/ids'
import { stampDrafts } from '../../events/stamp'

export const eventsFrom = (drafts: readonly EventDraft[]): Event[] =>
  stampDrafts({
    drafts,
    envelopes: drafts.map((_, index) => ({
      id: toEventId(`evt-${index + 1}`),
      seq: index + 1,
      branchId: toBranchId('branch-1'),
      runId: toRunId('run-1'),
      depth: 0,
      at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    })),
  })

export const said = (text: string): EventDraft => ({ type: 'user-said', text })

export const replied = (text: string): EventDraft => ({
  type: 'assistant-said',
  parts: [{ type: 'text', text }],
})

export const called = (callId: string): EventDraft => ({
  type: 'tool-called',
  callId: toCallId(callId),
  name: 'bash',
  input: { command: 'ls' },
  ordinal: 0,
})

export const resulted = (callId: string): EventDraft => ({
  type: 'tool-result',
  callId: toCallId(callId),
  name: 'bash',
  output: { ok: true },
  modelText: 'listed 3 files',
})

export const denied = (callId: string): EventDraft => ({
  type: 'tool-denied',
  callId: toCallId(callId),
  name: 'bash',
  reason: 'the operator said no',
})

export const compacted = (throughSeq: number, summary: string): EventDraft => ({
  type: 'history-compacted',
  throughSeq,
  summary,
  replaced: throughSeq,
})

export const loaded = (slot: string, key: string, content: string): EventDraft => ({
  type: 'context-loaded',
  slot,
  key,
  content,
})

export const resultedWith = (callId: string, output: string): EventDraft => ({
  type: 'tool-result',
  callId: toCallId(callId),
  name: 'read',
  output,
})
