import {
  DEFAULT_CLASSIFIER_POLICY,
  deedsOf,
  EConsultation,
  EJudgment,
  EMessageOrigin,
  EPathDeclaration,
  ERiskDimension,
  ESeverity,
  EToolEffect,
  JudgePort,
  NO_FACTS,
  readCommand,
  toCallId,
  toEventId,
  toRunId,
  toThreadId,
  type CallEvidence,
  type Consultation,
  type Event,
  type Grant,
  type RiskSignal,
  type ToolCall,
} from '@dltech/atlas-core'

import { JudgeMemo } from '../judge-memo'

export const THREAD = toThreadId('thread-1')

export const PROCEEDING: Consultation = {
  kind: EConsultation.Judged,
  verdict: { judgment: EJudgment.Proceed, reason: '' },
  elapsedMs: 400,
}

export const signalAt = (args: {
  severity: ESeverity
  subject?: string | undefined
}): RiskSignal => ({
  dimension: ERiskDimension.Irreversibility,
  severity: args.severity,
  id: `probe:${args.severity}`,
  subject: args.subject ?? 'path:/repo/src',
  detail: 'a detail line',
  ungrantable: false,
  unverified: false,
})

export const evidenceFor = (args: {
  command: string
  grants?: readonly Grant[] | undefined
}): CallEvidence => {
  const reading = readCommand({
    command: args.command,
    workdir: undefined,
    projectDirectory: '/repo',
  })
  const call: ToolCall = {
    callId: toCallId('call-1'),
    name: 'bash',
    input: { command: args.command },
    effect: EToolEffect.Destructive,
    threadId: THREAD,
  }

  return {
    deeds: deedsOf({
      call,
      declaration: { kind: EPathDeclaration.Declared, fields: [] },
      reading,
      projectDirectory: '/repo',
    }),
    toolName: 'bash',
    effect: EToolEffect.Destructive,
    threadId: THREAD,
    reading,
    facts: NO_FACTS,
    recent: [],
    said: [],
    grants: args.grants ?? [],
  }
}

export const said = (args: { seq: number; text: string }): Event => ({
  id: toEventId(`event-${args.seq}`),
  seq: args.seq,
  threadId: THREAD,
  runId: toRunId('run-1'),
  depth: 0,
  at: '2026-01-01T00:00:00.000Z',
  type: 'user-said',
  text: args.text,
  via: EMessageOrigin.Operator,
})

export const TURN_ONE: readonly Event[] = [said({ seq: 1, text: 'clean up the worktrees' })]

export const memoOver = (args: { judge: JudgePort; callsPerTurn?: number | undefined }) =>
  new JudgeMemo({
    judge: args.judge,
    policy: () => DEFAULT_CLASSIFIER_POLICY,
    ...(args.callsPerTurn === undefined ? {} : { callsPerTurn: args.callsPerTurn }),
  })

export const consultOver = async (args: {
  memo: JudgeMemo
  command: string
  standing: readonly RiskSignal[]
  events?: readonly Event[] | undefined
}): Promise<Consultation> =>
  args.memo.consult({
    evidence: evidenceFor({ command: args.command }),
    standing: args.standing,
    events: args.events ?? TURN_ONE,
    signal: new AbortController().signal,
  })

export const SERIOUS = [signalAt({ severity: ESeverity.Serious })]
