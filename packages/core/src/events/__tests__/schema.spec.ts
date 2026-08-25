import { describe, expect, it } from 'bun:test'

import { EDecision, type EventDraft } from '../body'
import type { EventEnvelope } from '../envelope'
import { toBranchId, toCallId, toEventId, toRunId } from '../ids'
import { eventBodySchema, eventEnvelopeSchema } from '../schema'

const bodies: EventDraft[] = [
  { type: 'user-said', text: 'hello' },
  { type: 'assistant-said', parts: [{ type: 'text', text: 'hi' }], interrupted: true },
  { type: 'tool-called', callId: toCallId('call-1'), name: 'read_file', input: { path: '/a' }, ordinal: 0 },
  { type: 'tool-result', callId: toCallId('call-1'), name: 'read_file', output: 'contents' },
  { type: 'tool-denied', callId: toCallId('call-1'), name: 'read_file', reason: 'no' },
  { type: 'approval-requested', callId: toCallId('call-1'), reason: 'writes' },
  { type: 'approval-answered', callId: toCallId('call-1'), decision: EDecision.Allow },
  { type: 'context-loaded', slot: 'claude-md', key: '/a/CLAUDE.md', content: '# rules' },
  { type: 'nudge', text: 'stay on task', lifetimeSteps: 2 },
]

describe('eventBodySchema', () => {
  it('round-trips every kind in the union through JSON', () => {
    const parsed = bodies.map((body) => eventBodySchema.parse(JSON.parse(JSON.stringify(body))))

    expect(parsed).toEqual(bodies)
  })

  it('keeps an opaque provider options bag intact rather than stripping it', () => {
    const body: EventDraft = {
      type: 'assistant-said',
      parts: [
        {
          type: 'reasoning',
          text: 'thinking',
          providerOptions: { anthropic: { signature: 'sig-abc', extra: { nested: [1, true, null] } } },
        },
      ],
    }

    expect(eventBodySchema.parse(JSON.parse(JSON.stringify(body)))).toEqual(body)
  })

  it('rejects a kind that is not in the union', () => {
    expect(() => eventBodySchema.parse({ type: 'tool-failed', callId: 'call-1' })).toThrow()
  })

  it('rejects a spoken turn with no text', () => {
    expect(() => eventBodySchema.parse({ type: 'user-said' })).toThrow()
  })

  it('rejects a call with no ordinal', () => {
    expect(() =>
      eventBodySchema.parse({ type: 'tool-called', callId: 'call-1', name: 'read_file', input: {} }),
    ).toThrow()
  })

  it('rejects a nudge with no lifetime', () => {
    expect(() => eventBodySchema.parse({ type: 'nudge', text: 'stay on task' })).toThrow()
  })

  it('rejects an approval answer with a decision outside the enum', () => {
    expect(() =>
      eventBodySchema.parse({ type: 'approval-answered', callId: 'call-1', decision: 'maybe' }),
    ).toThrow()
  })
})

describe('eventEnvelopeSchema', () => {
  const root: EventEnvelope = {
    id: toEventId('evt-1'),
    seq: 1,
    branchId: toBranchId('branch-1'),
    runId: toRunId('run-1'),
    depth: 0,
    at: '2026-08-24T00:00:00.000Z',
  }

  it('round-trips a root envelope', () => {
    expect(eventEnvelopeSchema.parse(JSON.parse(JSON.stringify(root)))).toEqual(root)
  })

  it('round-trips a nested run, keeping the parent run and the depth', () => {
    const nested: EventEnvelope = { ...root, runId: toRunId('run-2'), parentRunId: toRunId('run-1'), depth: 1 }

    expect(eventEnvelopeSchema.parse(JSON.parse(JSON.stringify(nested)))).toEqual(nested)
  })

  it('rejects an envelope with no depth', () => {
    expect(() =>
      eventEnvelopeSchema.parse({
        id: 'evt-1',
        seq: 1,
        branchId: 'branch-1',
        runId: 'run-1',
        at: '2026-08-24T00:00:00.000Z',
      }),
    ).toThrow()
  })

  it('rejects a negative depth and a sequence below one', () => {
    expect(() => eventEnvelopeSchema.parse({ ...root, depth: -1 })).toThrow()
    expect(() => eventEnvelopeSchema.parse({ ...root, seq: 0 })).toThrow()
  })
})
