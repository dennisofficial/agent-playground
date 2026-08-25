import { describe, expect, it } from 'bun:test'

import {
  EBeforeToolDecision,
  EDecision,
  EFinishReason,
  EHookPhase,
  EStage,
  EToolEffect,
  eventBodySchema,
  pendingCalls,
  stampEvent,
  toBranchId,
  toCallId,
  toEventId,
  toRunId,
  type Assembled,
  type EventDraft,
} from '../index'

describe('the package entry point', () => {
  it('describes a conversation, stamps it, and answers where the turn stands', () => {
    const draft: EventDraft = {
      type: 'tool-called',
      callId: toCallId('call-1'),
      name: 'read_file',
      input: { path: '/a' },
      ordinal: 0,
    }

    const event = stampEvent({
      draft: eventBodySchema.parse(draft),
      envelope: {
        id: toEventId('evt-1'),
        seq: 1,
        branchId: toBranchId('branch-1'),
        runId: toRunId('run-1'),
        depth: 0,
        at: '2026-08-24T00:00:00.000Z',
      },
    })

    expect(pendingCalls([event]).map((call) => call.name)).toEqual(['read_file'])
  })

  it('exposes an assembled prompt as system blocks and messages with provenance', () => {
    const assembled: Assembled = {
      system: [{ text: 'You are Atlas.' }],
      messages: [
        {
          message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
          origin: { eventId: toEventId('evt-1'), seq: 1 },
        },
      ],
    }

    expect(assembled.messages.map((entry) => entry.message.role)).toEqual(['user'])
  })

  it('exposes the enums the harness dispatches on', () => {
    const values: string[] = [
      EDecision.Allow,
      EBeforeToolDecision.Ask,
      EToolEffect.Destructive,
      EStage.Guard,
      EHookPhase.BeforeRequest,
      EFinishReason.ToolCalls,
    ]

    expect(values).toEqual(['allow', 'ask', 'destructive', 'guard', 'before-request', 'tool-calls'])
  })
})
