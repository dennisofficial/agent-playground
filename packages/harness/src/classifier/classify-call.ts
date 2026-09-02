import {
  adjudicate,
  BeforeToolHook,
  EBeforeToolDecision,
  EClassifierMode,
  EConsultation,
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
  type ClassifierPolicy,
  type Consultation,
  type Event,
  type EventDraft,
  type HookOrder,
  type RiskSignal,
  type SignalProbe,
  type ThreadId,
  type ToolCall,
  type ToolDeclaration,
  type Triage,
} from '@dltech/atlas-core'

import { collectEvidence } from './evidence-collector'
import { ECandidacy, prefilterOf } from './prefilter'
import { toolLensFor, type ToolLens } from './tool-lens'

export type JudgeSeam = {
  consult(args: {
    evidence: CallEvidence
    standing: readonly RiskSignal[]
    events: readonly Event[]
    signal: AbortSignal
  }): Promise<Consultation>
}

export type JudgeSource = () => JudgeSeam | undefined

export type ClassifyCallDeps = {
  tools: readonly ToolDeclaration[]
  facts: WorkspaceFactsPort
  launchDirectory: string
  policy: () => ClassifierPolicy
  probes?: readonly SignalProbe[] | undefined
  judge?: JudgeSource | undefined
  reportDisarm?: ((detail: string) => void) | undefined
  now?: (() => number) | undefined
}

type Weighed = { triage: Triage; consultation: Consultation | undefined }

const REASON_LIMIT = 400

const NO_JUDGE = 'no judge is bound to this session'

const CANNOT_PAUSE = `set to nudge, but ${NO_JUDGE}, so it is running as shadow and cannot pause you`

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

function faultDraft(args: {
  call: ToolCall
  mode: EClassifierMode
  fault: unknown
  elapsedMs: number
}): EventDraft {
  return {
    type: 'classifier-judged',
    callId: args.call.callId,
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
  private readonly judgeSource: JudgeSource | undefined
  private readonly reportDisarm: ((detail: string) => void) | undefined
  private readonly now: () => number
  private readonly lens: ToolLens

  private disarmAnnounced = false

  constructor(deps: ClassifyCallDeps) {
    super()
    this.facts = deps.facts
    this.launchDirectory = deps.launchDirectory
    this.policy = deps.policy
    this.probes = deps.probes
    this.judgeSource = deps.judge
    this.reportDisarm = deps.reportDisarm
    this.now = deps.now ?? (() => Date.now())
    this.lens = toolLensFor({ tools: deps.tools })
  }

  readonly run: BeforeTool = async ({ call, projectDirectory, events, signal }) => {
    const started = this.now()
    let mode = EClassifierMode.Shadow

    try {
      const judge = this.judgeSource?.()
      const policy = this.policyItCanHonour({ policy: this.policy(), judge })
      mode = policy.mode
      if (mode === EClassifierMode.Off) return allowing({ call })

      const weighed = await this.weigh({ call, projectDirectory, events, signal, policy, judge })
      if (weighed === undefined) return allowing({ call })

      return adjudicate({
        call,
        triage: weighed.triage,
        consultation: weighed.consultation,
        policy,
        elapsedMs: this.now() - started,
      })
    } catch (fault) {
      return allowing({
        call,
        drafts: [faultDraft({ call, mode, fault, elapsedMs: this.now() - started })],
      })
    }
  }

  private policyItCanHonour({
    policy,
    judge,
  }: {
    policy: ClassifierPolicy
    judge: JudgeSeam | undefined
  }): ClassifierPolicy {
    if (judge !== undefined) {
      this.disarmAnnounced = false
      return policy
    }
    if (policy.mode !== EClassifierMode.Nudge) return policy

    this.announceDisarm()
    return { ...policy, mode: EClassifierMode.Shadow }
  }

  private announceDisarm(): void {
    if (this.disarmAnnounced) return
    this.disarmAnnounced = true
    this.reportDisarm?.(CANNOT_PAUSE)
  }

  private async weigh(args: {
    call: ToolCall
    projectDirectory: string
    events: readonly Event[]
    signal: AbortSignal
    policy: ClassifierPolicy
    judge: JudgeSeam | undefined
  }): Promise<Weighed | undefined> {
    const { call, projectDirectory, events, signal, policy, judge } = args

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

    if (triage.triage !== ETriage.Consult) return { triage, consultation: undefined }

    if (judge === undefined) {
      return { triage, consultation: { kind: EConsultation.Unreachable, fault: NO_JUDGE } }
    }

    return {
      triage,
      consultation: await judge.consult({
        evidence,
        standing: triage.standing,
        events,
        signal,
      }),
    }
  }
}
