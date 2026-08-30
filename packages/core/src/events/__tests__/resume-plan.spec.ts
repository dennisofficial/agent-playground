import { describe, expect, it } from 'bun:test'

import { log } from '../../assembly/__tests__/log-fixture'
import { EDecision } from '../body'
import { toCallId } from '../ids'
import { EResume, isResumable, resumeDrafts, resumePlan, RESUME_NUDGE } from '../resume-plan'

describe('resumePlan', () => {
  it('has nothing to resume on an empty thread', () => {
    expect(resumePlan([])).toEqual({ kind: EResume.Nothing })
  })

  it('has nothing to resume when the model finished its say', () => {
    const events = log([
      { type: 'user-said', text: 'hello' },
      { type: 'assistant-said', parts: [{ type: 'text', text: 'hi' }] },
    ])

    expect(resumePlan(events)).toEqual({ kind: EResume.Nothing })
  })

  it('continues with nothing appended when a tool settled on its own', () => {
    const events = log([
      { type: 'user-said', text: 'run it' },
      { type: 'assistant-said', parts: [{ type: 'text', text: 'running' }] },
      { type: 'tool-called', callId: toCallId('call-1'), name: 'bash', input: {}, ordinal: 0 },
      { type: 'tool-result', callId: toCallId('call-1'), name: 'bash', output: { exitCode: 0 } },
    ])

    expect(resumePlan(events)).toEqual({ kind: EResume.Continue, nudge: false })
    expect(resumeDrafts(events)).toEqual([])
  })

  it('nudges when the last word is a tool the developer cut short', () => {
    const events = log([
      { type: 'user-said', text: 'run it' },
      { type: 'assistant-said', parts: [{ type: 'text', text: 'running' }] },
      { type: 'tool-called', callId: toCallId('call-1'), name: 'bash', input: {}, ordinal: 0 },
      {
        type: 'tool-result',
        callId: toCallId('call-1'),
        name: 'bash',
        output: undefined,
        error: { message: 'the developer interrupted the turn while the command was running' },
        interrupted: true,
      },
    ])

    expect(resumePlan(events)).toEqual({ kind: EResume.Continue, nudge: true })
    expect(resumeDrafts(events)).toEqual([{ type: 'nudge', text: RESUME_NUDGE, lifetimeSteps: 1 }])
  })

  it('nudges when a cut-short reply is followed by the tool call it never ran', () => {
    const events = log([
      { type: 'user-said', text: 'run it' },
      { type: 'assistant-said', parts: [{ type: 'text', text: 'running' }], interrupted: true },
      { type: 'tool-called', callId: toCallId('call-1'), name: 'bash', input: {}, ordinal: 0 },
      {
        type: 'tool-denied',
        callId: toCallId('call-1'),
        name: 'bash',
        reason: 'the developer interrupted the turn before this tool ran',
        interrupted: true,
      },
    ])

    expect(resumePlan(events)).toEqual({ kind: EResume.Continue, nudge: true })
    expect(resumeDrafts(events)).toEqual([{ type: 'nudge', text: RESUME_NUDGE, lifetimeSteps: 1 }])
  })

  it('leaves a tool the developer denied to speak for itself', () => {
    const events = log([
      { type: 'user-said', text: 'delete it' },
      { type: 'assistant-said', parts: [{ type: 'text', text: 'deleting' }] },
      { type: 'tool-called', callId: toCallId('call-1'), name: 'bash', input: {}, ordinal: 0 },
      {
        type: 'tool-denied',
        callId: toCallId('call-1'),
        name: 'bash',
        reason: 'the developer said no',
      },
    ])

    expect(resumePlan(events)).toEqual({ kind: EResume.Continue, nudge: false })
    expect(resumeDrafts(events)).toEqual([])
  })

  it('continues when the model asked for a tool that was never dispatched', () => {
    const events = log([
      { type: 'user-said', text: 'run it' },
      { type: 'assistant-said', parts: [{ type: 'text', text: 'running' }] },
      { type: 'tool-called', callId: toCallId('call-1'), name: 'bash', input: {}, ordinal: 0 },
    ])

    expect(resumePlan(events)).toEqual({ kind: EResume.Continue, nudge: false })
  })

  it('continues after a failed step, whose events never landed', () => {
    const events = log([{ type: 'user-said', text: 'hello' }])

    expect(resumePlan(events)).toEqual({ kind: EResume.Continue, nudge: false })
  })

  it('nudges when the interrupted reply is the last word', () => {
    const events = log([
      { type: 'user-said', text: 'explain' },
      { type: 'assistant-said', parts: [{ type: 'text', text: 'it works by' }], interrupted: true },
    ])

    const plan = resumePlan(events)

    expect(plan.kind).toBe(EResume.Nudge)
    expect(resumeDrafts(events)).toEqual([
      { type: 'nudge', text: RESUME_NUDGE, lifetimeSteps: 1 },
    ])
  })

  it('appends no second nudge, because a nudge is itself the last word', () => {
    const events = log([
      { type: 'user-said', text: 'explain' },
      { type: 'assistant-said', parts: [{ type: 'text', text: 'it works by' }], interrupted: true },
      { type: 'nudge', text: RESUME_NUDGE, lifetimeSteps: 1 },
    ])

    expect(resumePlan(events)).toEqual({ kind: EResume.Continue, nudge: false })
    expect(resumeDrafts(events)).toEqual([])
  })

  it('refuses to resume past an approval nobody answered', () => {
    const events = log([
      { type: 'user-said', text: 'delete it' },
      { type: 'tool-called', callId: toCallId('call-1'), name: 'bash', input: {}, ordinal: 0 },
      { type: 'approval-requested', callId: toCallId('call-1'), reason: 'this deletes files' },
    ])

    const plan = resumePlan(events)

    expect(plan.kind).toBe(EResume.Blocked)
    expect(isResumable(events)).toBe(false)
  })

  it('resumes once that approval has an answer', () => {
    const events = log([
      { type: 'user-said', text: 'delete it' },
      { type: 'tool-called', callId: toCallId('call-1'), name: 'bash', input: {}, ordinal: 0 },
      { type: 'approval-requested', callId: toCallId('call-1'), reason: 'this deletes files' },
      { type: 'approval-answered', callId: toCallId('call-1'), decision: EDecision.Allow },
    ])

    expect(resumePlan(events)).toEqual({ kind: EResume.Continue, nudge: false })
  })
})
