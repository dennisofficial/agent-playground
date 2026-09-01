import {
  BeforeToolHook,
  EBeforeToolDecision,
  EClassifierMode,
  EJudgment,
  EStage,
  ETriage,
  rowsOwnedBy,
  signalsFor,
  triageOf,
  WorkspaceFactsPort,
  type BeforeTool,
  type BeforeToolOutcome,
  type CallEvidence,
  type CallId,
  type ClassifierPolicy,
  type Event,
  type EventDraft,
  type HookOrder,
  type RiskSignal,
  type SignalProbe,
  type ThreadId,
  type ToolCall,
  type ToolDeclaration,
  type Triage,
  type Verdict,
} from '@dltech/atlas-core'

import { collectEvidence } from './evidence-collector'
import { ECandidacy, prefilterOf } from './prefilter'
import { toolLensFor, type ToolLens } from './tool-lens'

export type JudgeSeam = (args: {
  evidence: CallEvidence
  standing: readonly RiskSignal[]
  signal: AbortSignal
}) => Promise<Verdict | undefined>

export type ClassifyCallDeps = {
  tools: readonly ToolDeclaration[]
  facts: WorkspaceFactsPort
  launchDirectory: string
  policy: () => ClassifierPolicy
  probes?: readonly SignalProbe[] | undefined
  judge?: JudgeSeam | undefined
  now?: (() => number) | undefined
}

const REASON_LIMIT = 400

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const clipped = (text: string): string =>
  text.length <= REASON_LIMIT ? text : `${text.slice(0, REASON_LIMIT - 1)}…`

function asksSoFarIn({
  events,
  threadId,
}: {
  events: readonly Event[]
  threadId: ThreadId
}): number {
  return rowsOwnedBy({ events, threadId }).filter((event) => event.type === 'approval-requested')
    .length
}

function reasonFor({ triage, verdict }: { triage: Triage; verdict: Verdict | undefined }): string {
  if (verdict !== undefined) return clipped(verdict.reason)

  const fatigue = triage.fatigued ? ' (this thread has spent its interruptions)' : ''
  if (triage.standing.length > 0) {
    return clipped(`${triage.standing.map((signal) => signal.detail).join('; ')}${fatigue}`)
  }

  if (triage.cleared.length > 0) {
    const subjects = [...new Set(triage.cleared.map((cleared) => cleared.signal.subject))]
    return clipped(`a standing grant covers ${subjects.join(', ')}`)
  }

  return 'nothing the probes watch for fired'
}

function judgedDraft(args: {
  callId: CallId
  mode: EClassifierMode
  triage: Triage
  verdict: Verdict | undefined
  elapsedMs: number
}): EventDraft {
  const { callId, mode, triage, verdict } = args

  return {
    type: 'classifier-judged',
    callId,
    mode,
    triage: triage.triage,
    judgment: verdict?.judgment ?? EJudgment.Proceed,
    dimensions: [...new Set(triage.standing.map((signal) => signal.dimension))],
    signalIds: triage.standing.map((signal) => signal.id),
    reason: reasonFor({ triage, verdict }),
    consulted: verdict !== undefined,
    elapsedMs: args.elapsedMs,
  }
}

function faultDraft(args: {
  callId: CallId
  mode: EClassifierMode
  fault: unknown
  elapsedMs: number
}): EventDraft {
  return {
    type: 'classifier-judged',
    callId: args.callId,
    mode: args.mode,
    triage: ETriage.Clear,
    judgment: EJudgment.Proceed,
    dimensions: [],
    signalIds: ['classifier:fault'],
    reason: clipped(`the classifier failed and let the call through: ${messageOf(args.fault)}`),
    consulted: false,
    elapsedMs: args.elapsedMs,
  }
}

const allowing = (args: {
  call: ToolCall
  drafts?: readonly EventDraft[] | undefined
}): BeforeToolOutcome => ({
  decision: EBeforeToolDecision.Allow,
  input: args.call.input,
  ...(args.drafts === undefined ? {} : { drafts: args.drafts }),
})

export class ClassifyCallHook extends BeforeToolHook {
  readonly name = 'classifyCall'
  readonly order: HookOrder = { stage: EStage.Policy, nudge: 0 }

  private readonly facts: WorkspaceFactsPort
  private readonly launchDirectory: string
  private readonly policy: () => ClassifierPolicy
  private readonly probes: readonly SignalProbe[] | undefined
  private readonly judge: JudgeSeam | undefined
  private readonly now: () => number
  private readonly lens: ToolLens

  constructor(deps: ClassifyCallDeps) {
    super()
    this.facts = deps.facts
    this.launchDirectory = deps.launchDirectory
    this.policy = deps.policy
    this.probes = deps.probes
    this.judge = deps.judge
    this.now = deps.now ?? (() => Date.now())
    this.lens = toolLensFor({ tools: deps.tools })
  }

  readonly run: BeforeTool = async ({ call, projectDirectory, events, signal }) => {
    const started = this.now()
    let mode = EClassifierMode.Shadow

    try {
      const policy = this.policy()
      mode = policy.mode
      if (mode === EClassifierMode.Off) return allowing({ call })

      const verdicted = await this.weigh({ call, projectDirectory, events, signal, policy })
      if (verdicted === undefined) return allowing({ call })

      return allowing({
        call,
        drafts: [
          judgedDraft({
            callId: call.callId,
            mode,
            triage: verdicted.triage,
            verdict: verdicted.verdict,
            elapsedMs: this.now() - started,
          }),
        ],
      })
    } catch (fault) {
      return allowing({
        call,
        drafts: [faultDraft({ callId: call.callId, mode, fault, elapsedMs: this.now() - started })],
      })
    }
  }

  private async weigh(args: {
    call: ToolCall
    projectDirectory: string
    events: readonly Event[]
    signal: AbortSignal
    policy: ClassifierPolicy
  }): Promise<{ triage: Triage; verdict: Verdict | undefined } | undefined> {
    const { call, projectDirectory, events, signal, policy } = args

    const reading = this.lens.readingFor({
      name: call.name,
      input: call.input,
      projectDirectory,
    })
    const prefiltered = prefilterOf({
      call,
      declaration: this.lens.declarationFor(call.name),
      reading,
      projectDirectory,
      events,
    })
    if (prefiltered.candidacy === ECandidacy.Clear) return undefined

    const evidence = await collectEvidence({
      call,
      deeds: prefiltered.deeds,
      reading,
      events,
      projectDirectory,
      launchDirectory: this.launchDirectory,
      facts: this.facts,
      lens: this.lens,
    })

    const triage = triageOf({
      evidence,
      signals: signalsFor({ evidence, probes: this.probes }),
      policy,
      asksSoFar: asksSoFarIn({ events, threadId: call.threadId }),
    })

    if (triage.triage !== ETriage.Consult || this.judge === undefined) {
      return { triage, verdict: undefined }
    }

    return { triage, verdict: await this.judge({ evidence, standing: triage.standing, signal }) }
  }
}
