import { describe, expect, it } from 'bun:test'

import {
  EDecision,
  stampDrafts,
  toEventId,
  toRunId,
  toThreadId,
  type Event,
  type EventDraft,
} from '@dltech/atlas-core'

import { classify } from '../tools/classify'
import { ECallState, settled, succeeded, toolRuns } from '../tool-runs'
import { called, callId, denied, result } from './tool-fixture'

const log = (drafts: readonly EventDraft[]): Event[] =>
  stampDrafts({
    drafts,
    envelopes: drafts.map((_draft, index) => ({
      id: toEventId(`event-${index + 1}`),
      seq: index + 1,
      threadId: toThreadId('thread-approval'),
      runId: toRunId('run-approval'),
      depth: 0,
      at: '2026-01-01T00:00:00.000Z',
    })),
  })

const REASON = 'this would reset a worktree another session is standing in'

const asked = (args: { n: number; reason?: string }): EventDraft => ({
  type: 'approval-requested',
  callId: callId(args.n),
  reason: args.reason ?? REASON,
})

const answered = (args: { n: number; decision: EDecision }): EventDraft => ({
  type: 'approval-answered',
  callId: callId(args.n),
  decision: args.decision,
})

const onlyCall = (events: readonly Event[]) => {
  const call = toolRuns(events)[0]?.calls[0]
  if (call === undefined) throw new Error('the fixture produced no call')
  return call
}

describe('a call parked on an approval', () => {
  it('reads as awaiting approval rather than still running', () => {
    const call = onlyCall(log([called({ n: 1, name: 'bash' }), asked({ n: 1 })]))

    expect(call.state).toBe(ECallState.AwaitingApproval)
    expect(call.note).toBe(REASON)
  })

  it('is still open, so nothing downstream treats it as a finished or failed call', () => {
    const call = onlyCall(log([called({ n: 1, name: 'bash' }), asked({ n: 1 })]))

    expect(settled(call)).toBe(false)
    expect(succeeded(call)).toBe(true)
  })

  it('does not read as failed work in the transcript', () => {
    const call = onlyCall(log([called({ n: 1, name: 'bash' }), asked({ n: 1 })]))

    expect(classify({ call, cwd: '/project' }).failed).toBe(false)
  })

  it('goes back to running once the operator has answered', () => {
    const call = onlyCall(
      log([
        called({ n: 1, name: 'bash' }),
        asked({ n: 1 }),
        answered({ n: 1, decision: EDecision.Allow }),
      ]),
    )

    expect(call.state).toBe(ECallState.Pending)
    expect(call.note).toBeNull()
  })

  it('reads as denied once the refusal has been recorded against the call', () => {
    const call = onlyCall(
      log([
        called({ n: 1, name: 'bash' }),
        asked({ n: 1 }),
        answered({ n: 1, decision: EDecision.Deny }),
        denied({ n: 1, name: 'bash', reason: 'the operator declined this call' }),
      ]),
    )

    expect(call.state).toBe(ECallState.Denied)
  })

  it('leaves a call nobody was asked about running', () => {
    const call = onlyCall(log([called({ n: 1, name: 'bash' }), called({ n: 2, name: 'read' })]))

    expect(call.state).toBe(ECallState.Pending)
  })

  it('parks only the call the question named', () => {
    const runs = toolRuns(
      log([called({ n: 1, name: 'bash' }), called({ n: 2, name: 'read' }), asked({ n: 1 })]),
    )

    expect(runs[0]?.calls.map((call) => call.state)).toEqual([
      ECallState.AwaitingApproval,
      ECallState.Pending,
    ])
  })

  it('lets a result settle a call the operator was asked about but never answered', () => {
    const call = onlyCall(
      log([called({ n: 1, name: 'bash' }), asked({ n: 1 }), result({ n: 1, name: 'bash' })]),
    )

    expect(call.state).toBe(ECallState.Ok)
  })
})
