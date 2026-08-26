import {
  stampDrafts,
  toBranchId,
  toCallId,
  toEventId,
  toRunId,
  type CallId,
  type Event,
  type EventDraft,
} from '@dltech/atlas-core'

export const callId = (n: number): CallId => toCallId(`call-${n}`)

export const called = (args: { n: number; name: string; input?: unknown }): EventDraft => ({
  type: 'tool-called',
  callId: callId(args.n),
  name: args.name,
  input: args.input ?? {},
  ordinal: args.n,
})

export const result = (args: { n: number; name: string; output?: unknown }): EventDraft => ({
  type: 'tool-result',
  callId: callId(args.n),
  name: args.name,
  output: args.output ?? {},
})

export const failed = (args: { n: number; name: string; message: string }): EventDraft => ({
  type: 'tool-result',
  callId: callId(args.n),
  name: args.name,
  output: null,
  error: { message: args.message },
})

export const denied = (args: { n: number; name: string; reason: string }): EventDraft => ({
  type: 'tool-denied',
  callId: callId(args.n),
  name: args.name,
  reason: args.reason,
})

export const said = (text: string): EventDraft => ({
  type: 'assistant-said',
  parts: [{ type: 'text', text }],
})

export type ClockedDraft = { draft: EventDraft; at: string }

export function clocked(drafts: readonly ClockedDraft[]): Event[] {
  return stampDrafts({
    drafts: drafts.map((entry) => entry.draft),
    envelopes: drafts.map((entry, index) => ({
      id: toEventId(`clocked-${index + 1}`),
      seq: index + 1,
      branchId: toBranchId('branch-clocked'),
      runId: toRunId('run-clocked'),
      depth: 0,
      at: entry.at,
    })),
  })
}
