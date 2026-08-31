import { describe, expect, it } from 'bun:test'

import { toCallId, toThreadId } from '../../events/ids'
import { EToolEffect, type ToolCall } from '../../tools/tool'
import { EBeforeToolDecision, resolveBeforeTool, type BeforeToolOutcome } from '../before-tool'

const call: ToolCall = {
  callId: toCallId('call-1'),
  name: 'write_file',
  input: { path: 'src/a.ts' },
  effect: EToolEffect.Write,
  threadId: toThreadId('thread-1'),
}

describe('resolveBeforeTool', () => {
  it('allows a call no hook looked at, carrying the original input', () => {
    expect(resolveBeforeTool({ call, outcomes: [] })).toEqual({
      outcome: { decision: EBeforeToolDecision.Allow, input: { path: 'src/a.ts' } },
      dissenters: [],
    })
  })

  it('carries the last rewrite when three hooks allow in sequence', () => {
    const resolution = resolveBeforeTool({
      call,
      outcomes: [
        { hookName: 'absolutise', outcome: { decision: EBeforeToolDecision.Allow, input: { path: '/w/src/a.ts' } } },
        { hookName: 'realpath', outcome: { decision: EBeforeToolDecision.Allow, input: { path: '/private/w/src/a.ts' } } },
        { hookName: 'observe', outcome: { decision: EBeforeToolDecision.Allow, input: { path: '/private/w/src/a.ts' } } },
      ],
    })

    expect(resolution).toEqual({
      outcome: { decision: EBeforeToolDecision.Allow, input: { path: '/private/w/src/a.ts' } },
      dissenters: [],
    })
  })

  it('denies the call when one hook among allowers denies, and names the denier', () => {
    const resolution = resolveBeforeTool({
      call,
      outcomes: [
        { hookName: 'absolutise', outcome: { decision: EBeforeToolDecision.Allow, input: { path: '/w/src/a.ts' } } },
        { hookName: 'boundary', outcome: { decision: EBeforeToolDecision.Deny, reason: 'outside the workspace root' } },
        { hookName: 'observe', outcome: { decision: EBeforeToolDecision.Allow, input: { path: '/w/src/a.ts' } } },
      ],
    })

    expect(resolution).toEqual({
      outcome: { decision: EBeforeToolDecision.Deny, reason: 'outside the workspace root' },
      dissenters: [{ hookName: 'boundary', decision: EBeforeToolDecision.Deny, reason: 'outside the workspace root' }],
    })
  })

  it('asks when a hook asks and nobody denies', () => {
    const resolution = resolveBeforeTool({
      call,
      outcomes: [
        { hookName: 'approvals', outcome: { decision: EBeforeToolDecision.Ask, reason: 'writes need a human' } },
      ],
    })

    expect(resolution).toEqual({
      outcome: { decision: EBeforeToolDecision.Ask, reason: 'writes need a human' },
      dissenters: [{ hookName: 'approvals', decision: EBeforeToolDecision.Ask, reason: 'writes need a human' }],
    })
  })

  it('lets a deny outrank an earlier ask while still naming the asker', () => {
    const resolution = resolveBeforeTool({
      call,
      outcomes: [
        { hookName: 'approvals', outcome: { decision: EBeforeToolDecision.Ask, reason: 'writes need a human' } },
        { hookName: 'boundary', outcome: { decision: EBeforeToolDecision.Deny, reason: 'outside the workspace root' } },
      ],
    })

    expect(resolution).toEqual({
      outcome: { decision: EBeforeToolDecision.Deny, reason: 'outside the workspace root' },
      dissenters: [
        { hookName: 'approvals', decision: EBeforeToolDecision.Ask, reason: 'writes need a human' },
        { hookName: 'boundary', decision: EBeforeToolDecision.Deny, reason: 'outside the workspace root' },
      ],
    })
  })

  it('reports the first denial when two hooks deny', () => {
    const resolution = resolveBeforeTool({
      call,
      outcomes: [
        { hookName: 'boundary', outcome: { decision: EBeforeToolDecision.Deny, reason: 'outside the workspace root' } },
        { hookName: 'secrets', outcome: { decision: EBeforeToolDecision.Deny, reason: 'touches .env.keys' } },
      ],
    })

    expect(resolution.outcome).toEqual({
      decision: EBeforeToolDecision.Deny,
      reason: 'outside the workspace root',
    })
    expect(resolution.dissenters.map((dissent) => dissent.hookName)).toEqual(['boundary', 'secrets'])
  })
})

describe('resolveBeforeTool when a hook returns a decision without a reason', () => {
  const call: ToolCall = {
    callId: toCallId('call_reasonless'),
    name: 'write',
    input: { path: '/tmp/x' },
    effect: EToolEffect.Write,
    threadId: toThreadId('thread-1'),
  }

  const acrossABoundary = (outcome: { decision: EBeforeToolDecision }): BeforeToolOutcome =>
    JSON.parse(JSON.stringify(outcome))

  const reasonless = (decision: EBeforeToolDecision.Ask | EBeforeToolDecision.Deny) =>
    resolveBeforeTool({
      call,
      outcomes: [{ hookName: 'silentGuard', outcome: acrossABoundary({ decision }) }],
    })

  it('still denies, rather than falling through to allow', () => {
    const { outcome } = reasonless(EBeforeToolDecision.Deny)
    expect(outcome.decision).toBe(EBeforeToolDecision.Deny)
  })

  it('names the hook that denied without saying why', () => {
    const { outcome } = reasonless(EBeforeToolDecision.Deny)
    if (outcome.decision === EBeforeToolDecision.Allow) throw new Error('expected a denial')
    expect(outcome.reason).toContain('silentGuard')
  })

  it('still asks, rather than falling through to allow', () => {
    const { outcome } = reasonless(EBeforeToolDecision.Ask)
    expect(outcome.decision).toBe(EBeforeToolDecision.Ask)
  })

  it('prefers a reasonless denial over a later well-formed ask', () => {
    const { outcome } = resolveBeforeTool({
      call,
      outcomes: [
        { hookName: 'silentGuard', outcome: acrossABoundary({ decision: EBeforeToolDecision.Deny }) },
        {
          hookName: 'approvals',
          outcome: { decision: EBeforeToolDecision.Ask, reason: 'are you sure?' },
        },
      ],
    })

    expect(outcome.decision).toBe(EBeforeToolDecision.Deny)
  })
})
