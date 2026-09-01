import {
  briefOf,
  deedFingerprint,
  EConsultation,
  ESeverity,
  eventsOfType,
  JudgePort,
  reachesSeverity,
  rowsOwnedBy,
  type CallEvidence,
  type ClassifierPolicy,
  type Consultation,
  type Event,
  type RiskSignal,
  type ThreadId,
} from '@dltech/atlas-core'

export const JUDGE_CALLS_PER_TURN = 6

const CONSULTS_PAST_THE_BUDGET = ESeverity.Grave

export function turnKeyOf({
  events,
  threadId,
}: {
  events: readonly Event[]
  threadId: ThreadId
}): string {
  const said = eventsOfType({ events: rowsOwnedBy({ events, threadId }), type: 'user-said' }).at(-1)
  return `${threadId}@${said?.seq ?? 0}`
}

export function memoKeyOf({
  evidence,
  standing,
}: {
  evidence: CallEvidence
  standing: readonly RiskSignal[]
}): string {
  const deeds = evidence.deeds.map((deed) => deedFingerprint({ deed })).sort()
  const signals = standing.map((signal) => `${signal.id}|${signal.subject}`).sort()
  const generation = evidence.grants.map((grant) => `${grant.grantId}@${grant.seq}`).sort()

  return [evidence.toolName, deeds.join(' '), signals.join(' '), generation.join(' ')].join('||')
}

export type JudgeMemoDeps = {
  judge: JudgePort
  policy: () => ClassifierPolicy
  callsPerTurn?: number | undefined
}

export class JudgeMemo {
  private readonly judge: JudgePort
  private readonly policy: () => ClassifierPolicy
  private readonly callsPerTurn: number
  private readonly answered = new Map<string, Consultation>()

  private turn = ''
  private calls = 0

  constructor(deps: JudgeMemoDeps) {
    this.judge = deps.judge
    this.policy = deps.policy
    this.callsPerTurn = deps.callsPerTurn ?? JUDGE_CALLS_PER_TURN
  }

  async consult({
    evidence,
    standing,
    events,
    signal,
  }: {
    evidence: CallEvidence
    standing: readonly RiskSignal[]
    events: readonly Event[]
    signal: AbortSignal
  }): Promise<Consultation> {
    this.openTurn({ turn: turnKeyOf({ events, threadId: evidence.threadId }) })

    const key = memoKeyOf({ evidence, standing })
    const held = this.answered.get(key)
    if (held !== undefined) return held

    if (this.budgetSpent({ standing })) {
      return { kind: EConsultation.Budgeted, calls: this.calls }
    }

    this.calls += 1
    const consultation = await this.judge.consult({
      brief: briefOf({ evidence, standing, policy: this.policy() }),
      signal,
    })

    this.answered.set(key, consultation)
    return consultation
  }

  private openTurn({ turn }: { turn: string }): void {
    if (turn === this.turn) return
    this.turn = turn
    this.calls = 0
    this.answered.clear()
  }

  private budgetSpent({ standing }: { standing: readonly RiskSignal[] }): boolean {
    if (this.calls < this.callsPerTurn) return false

    return !standing.some((signal) =>
      reachesSeverity({ severity: signal.severity, floor: CONSULTS_PAST_THE_BUDGET }),
    )
  }
}
