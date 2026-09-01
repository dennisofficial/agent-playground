import { describe, expect, it } from 'bun:test'

import { EAgentStart } from '../../agents/start'
import { EAgentStatus } from '../../agents/status'
import { ERiskDimension } from '../../policy/classifier/dimension'
import { EGrantScope } from '../../policy/classifier/grant'
import { EClassifierMode, ETriage } from '../../policy/classifier/triage'
import { EJudgment } from '../../policy/classifier/verdict'
import { EKilledBy } from '../../shells/status'
import { EDecision, EMessageOrigin, type EventDraft } from '../body'
import type { EventEnvelope } from '../envelope'
import { toThreadId, toCallId, toEventId, toRunId } from '../ids'
import { eventBodySchema, eventEnvelopeSchema } from '../schema'

const bodies: EventDraft[] = [
  { type: 'user-said', text: 'hello' },
  { type: 'user-said', text: 'carry on', via: EMessageOrigin.ParentAgent },
  { type: 'assistant-said', parts: [{ type: 'text', text: 'hi' }], interrupted: true },
  { type: 'tool-called', callId: toCallId('call-1'), name: 'read_file', input: { path: '/a' }, ordinal: 0 },
  { type: 'tool-result', callId: toCallId('call-1'), name: 'read_file', output: 'contents' },
  { type: 'tool-denied', callId: toCallId('call-1'), name: 'read_file', reason: 'no' },
  { type: 'approval-requested', callId: toCallId('call-1'), reason: 'writes' },
  { type: 'approval-answered', callId: toCallId('call-1'), decision: EDecision.Allow },
  { type: 'context-loaded', slot: 'claude-md', key: '/a/CLAUDE.md', content: '# rules' },
  { type: 'nudge', text: 'stay on task', lifetimeSteps: 2 },
  {
    type: 'agent-spawned',
    agentId: toThreadId('thread-child-1'),
    agentType: 'explore',
    intent: 'audit the settings registry',
    mode: EAgentStart.Fresh,
  },
  {
    type: 'agent-ended',
    agentId: toThreadId('thread-child-1'),
    agentType: 'explore',
    intent: 'audit the settings registry',
    status: EAgentStatus.Finished,
    prose: 'The registry has 14 settings; two are unread.',
    turns: 4,
    toolCalls: 11,
  },
  {
    type: 'agent-ended',
    agentId: toThreadId('thread-child-1'),
    agentType: 'explore',
    intent: 'audit the settings registry',
    status: EAgentStatus.Stopped,
    killedBy: EKilledBy.Unrecorded,
    prose: 'I had read four files.',
    turns: 1,
    toolCalls: 4,
  },
  {
    type: 'agent-ended',
    agentId: toThreadId('thread-child-1'),
    agentType: 'explore',
    intent: 'audit the settings registry',
    status: EAgentStatus.Stopped,
    killedBy: EKilledBy.User,
    prose: 'I was looking at the registry.',
    turns: 1,
    toolCalls: 2,
  },
  {
    type: 'background-shell-matched',
    shellId: 'bash_1',
    command: 'bun test',
    pattern: '(fail|error)',
    lines: '12 fail\n',
    matchCount: 1,
  },
  {
    type: 'background-shell-matched',
    shellId: 'bash_1',
    command: 'bun test',
    description: 'Run full TUI suite',
    pattern: '(fail|error)',
    lines: '12 fail\n13 fail\n',
    matchCount: 200,
    watchDisarmed: true,
  },
  {
    type: 'classifier-judged',
    callId: toCallId('call-1'),
    mode: EClassifierMode.Shadow,
    triage: ETriage.Consult,
    judgment: EJudgment.Check,
    dimensions: [ERiskDimension.Contention, ERiskDimension.Irreversibility],
    judgedDimension: ERiskDimension.Contention,
    signalIds: ['contention.dirty-foreign-worktree'],
    reason: 'contention: eng-412-sidebar holds 4 changed files',
    consulted: true,
    elapsedMs: 612,
  },
  {
    type: 'classifier-judged',
    callId: toCallId('call-2'),
    mode: EClassifierMode.Nudge,
    triage: ETriage.Clear,
    judgment: EJudgment.Proceed,
    dimensions: [],
    signalIds: [],
    reason: '',
    consulted: false,
    elapsedMs: 0,
  },
  {
    type: 'permission-granted',
    grantId: 'grant-1',
    dimensions: [ERiskDimension.Reach],
    scope: EGrantScope.Thread,
    subject: 'worktree:eng-412-sidebar',
    reason: 'the operator chose to stop being asked about this',
  },
  { type: 'permission-revoked', grantId: 'grant-1' },
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

  it('reads a failed tool result back, though stringify dropped its undefined output', () => {
    const body: EventDraft = {
      type: 'tool-result',
      callId: toCallId('call-1'),
      name: 'shell_output',
      output: undefined,
      error: { message: 'no background shell is registered as "bash_2"' },
    }
    const written = JSON.stringify(body)

    expect(Object.keys(JSON.parse(written))).not.toContain('output')
    expect(eventBodySchema.parse(JSON.parse(written))).toEqual(body)
  })

  it('reads a call back, though stringify dropped its undefined input', () => {
    const body: EventDraft = {
      type: 'tool-called',
      callId: toCallId('call-1'),
      name: 'shell_list',
      input: undefined,
      ordinal: 0,
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

  it('rejects a classifier verdict whose judgment is outside the enum', () => {
    expect(() =>
      eventBodySchema.parse({
        type: 'classifier-judged',
        callId: 'call-1',
        mode: EClassifierMode.Shadow,
        triage: ETriage.Consult,
        judgment: 'maybe',
        dimensions: [],
        signalIds: [],
        reason: '',
        consulted: true,
        elapsedMs: 1,
      }),
    ).toThrow()
  })

  it('rejects a classifier verdict whose judged dimension is outside the enum', () => {
    expect(() =>
      eventBodySchema.parse({
        type: 'classifier-judged',
        callId: 'call-1',
        mode: EClassifierMode.Shadow,
        triage: ETriage.Consult,
        judgment: EJudgment.Check,
        dimensions: [ERiskDimension.Contention],
        judgedDimension: 'vibes',
        signalIds: [],
        reason: 'contention: eng-412-sidebar',
        consulted: true,
        elapsedMs: 1,
      }),
    ).toThrow()
  })

  it('rejects a classifier verdict that names a dimension the enum does not have', () => {
    expect(() =>
      eventBodySchema.parse({
        type: 'classifier-judged',
        callId: 'call-1',
        mode: EClassifierMode.Shadow,
        triage: ETriage.Consult,
        judgment: EJudgment.Proceed,
        dimensions: ['vibes'],
        signalIds: [],
        reason: '',
        consulted: true,
        elapsedMs: 1,
      }),
    ).toThrow()
  })

  it('rejects a grant with no subject to be scoped to', () => {
    expect(() =>
      eventBodySchema.parse({
        type: 'permission-granted',
        grantId: 'grant-1',
        dimensions: [ERiskDimension.Reach],
        scope: EGrantScope.Thread,
        subject: '',
        reason: 'because',
      }),
    ).toThrow()
  })

  it('rejects a watch match that names no pattern', () => {
    expect(() =>
      eventBodySchema.parse({
        type: 'background-shell-matched',
        shellId: 'bash_1',
        command: 'bun test',
        pattern: '',
        lines: '12 fail\n',
        matchCount: 1,
      }),
    ).toThrow()
  })

  it('rejects a revocation that names no grant', () => {
    expect(() => eventBodySchema.parse({ type: 'permission-revoked' })).toThrow()
  })

  it('strips a key the classifier row does not declare rather than carrying it forward', () => {
    const parsed = eventBodySchema.safeParse({
      type: 'permission-revoked',
      grantId: 'grant-1',
      grantedBy: 'the judge',
    })

    expect(parsed.success).toBe(true)
    expect(parsed.success && 'grantedBy' in parsed.data).toBe(false)
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
    threadId: toThreadId('thread-1'),
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
        threadId: 'thread-1',
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

describe('a row written before workspace snapshots were removed', () => {
  it('still decodes, with the field it no longer has quietly dropped', () => {
    const stored = {
      type: 'tool-result',
      callId: 'call-1',
      name: 'bash',
      output: { ok: true },
      snapshotId: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
    }

    const parsed = eventBodySchema.safeParse(stored)

    expect(parsed.success).toBe(true)
    expect(parsed.success && 'snapshotId' in parsed.data).toBe(false)
  })
})

describe('a tool result that carries an image', () => {
  const stored: EventDraft = {
    type: 'tool-result',
    callId: toCallId('call-1'),
    name: 'read',
    output: { path: '/repo/docs/shot.png', inlined: true },
    modelText: '/repo/docs/shot.png — image/png, 8×8, 1 KB.',
    modelParts: [
      { type: 'text', text: '/repo/docs/shot.png — image/png, 8×8, 1 KB.' },
      { type: 'image', data: 'iVBOR', mediaType: 'image/png', source: '/repo/docs/shot.png' },
    ],
  }

  it('keeps the pixels and the path they came from across a round trip', () => {
    const parsed = eventBodySchema.safeParse(stored)

    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data).toEqual(stored)
  })
})
