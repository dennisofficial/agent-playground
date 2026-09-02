import {
  adjudicate,
  eventsOfType,
  operatorUtterances,
  rowsOwnedBy,
  signalsFor,
  triageOf,
  undoingAfter,
  EConsultation,
  ETriage,
  type CallEvidence,
  type CallId,
  type ClassifierPolicy,
  type Consultation,
  type EDeed,
  type Event,
  type EventDraft,
  type EventOfType,
  type JudgedDraft,
  type ReplayedAct,
  type ThreadId,
  type ToolCall,
  type ToolDeclaration,
  type Undoing,
  type WorkspaceFactsPort,
} from '@dltech/atlas-core'

import type { JudgeSeam } from './classify-call'
import { collectEvidence } from './evidence-collector'
import { ECandidacy, prefilterOf } from './prefilter'
import { toolLensFor, type ToolLens } from './tool-lens'

export type ReplayRow = {
  seq: number
  callId: CallId
  toolName: string
  deeds: readonly EDeed[]
  evidence: CallEvidence | undefined
  judged: JudgedDraft | undefined
  consultation: EConsultation | undefined
  grantCleared: boolean
  askedThen: boolean
  undone: Undoing | undefined
}

export type ReplayReport = {
  threadId: ThreadId
  projectDirectory: string
  turns: number
  calls: number
  rows: readonly ReplayRow[]
}

export type ReplayDeps = {
  events: readonly Event[]
  threadId: ThreadId
  projectDirectory: string
  launchDirectory: string
  tools: readonly ToolDeclaration[]
  facts: WorkspaceFactsPort
  policy: ClassifierPolicy
  judge?: JudgeSeam | undefined
  signal?: AbortSignal | undefined
}

type Called = EventOfType<'tool-called'>

type Weighed = {
  deeds: readonly EDeed[]
  evidence: CallEvidence | undefined
  judged: JudgedDraft | undefined
  consultation: EConsultation | undefined
  grantCleared: boolean
  act: ReplayedAct
}

const NOT_REPLAYED = 0

const asksBefore = ({
  events,
  threadId,
}: {
  events: readonly Event[]
  threadId: ThreadId
}): number =>
  rowsOwnedBy({ events, threadId }).filter((event) => event.type === 'approval-requested').length

const askedCalls = ({ events }: { events: readonly Event[] }): ReadonlySet<CallId> =>
  new Set(eventsOfType({ events, type: 'approval-requested' }).map((event) => event.callId))

const judgedDraftIn = ({
  drafts,
}: {
  drafts: readonly EventDraft[] | undefined
}): JudgedDraft | undefined =>
  drafts?.find((draft): draft is JudgedDraft => draft.type === 'classifier-judged')

function callFrom({ event, lens }: { event: Called; lens: ToolLens }): ToolCall {
  return {
    callId: event.callId,
    name: event.name,
    input: event.input,
    effect: lens.effectOf(event.name),
    threadId: event.threadId,
  }
}

async function weigh(args: {
  event: Called
  before: readonly Event[]
  lens: ToolLens
  deps: ReplayDeps
  signal: AbortSignal
}): Promise<Weighed> {
  const { event, before, lens, deps, signal } = args
  const call = callFrom({ event, lens })
  const reading = lens.readingFor({
    name: event.name,
    input: event.input,
    projectDirectory: deps.projectDirectory,
  })
  const prefiltered = prefilterOf({
    call,
    declaration: lens.declarationFor(event.name),
    reading,
    projectDirectory: deps.projectDirectory,
    events: before,
  })
  const act: ReplayedAct = { seq: event.seq, deeds: prefiltered.deeds, reading }
  const deeds = prefiltered.deeds.map((deed) => deed.action)

  if (prefiltered.candidacy === ECandidacy.Clear) {
    return {
      deeds,
      evidence: undefined,
      judged: undefined,
      consultation: undefined,
      grantCleared: false,
      act,
    }
  }

  const evidence = await collectEvidence({
    call,
    deeds: prefiltered.deeds,
    reading,
    events: before,
    projectDirectory: deps.projectDirectory,
    launchDirectory: deps.launchDirectory,
    facts: deps.facts,
    lens,
  })

  const triage = triageOf({
    evidence,
    signals: signalsFor({ evidence }),
    policy: deps.policy,
    asksSoFar: asksBefore({ events: before, threadId: event.threadId }),
  })

  const consultation: Consultation | undefined =
    triage.triage === ETriage.Consult && deps.judge !== undefined
      ? await deps.judge.consult({ evidence, standing: triage.standing, events: before, signal })
      : undefined

  const outcome = adjudicate({
    call,
    triage,
    consultation,
    policy: deps.policy,
    elapsedMs: NOT_REPLAYED,
  })

  return {
    deeds,
    evidence,
    judged: judgedDraftIn({ drafts: outcome.drafts }),
    consultation: consultation?.kind,
    grantCleared: triage.cleared.length > 0,
    act,
  }
}

export async function replayThread(deps: ReplayDeps): Promise<ReplayReport> {
  const { events } = deps
  const lens = toolLensFor({ tools: deps.tools })
  const asked = askedCalls({ events })
  const signal = deps.signal ?? new AbortController().signal

  const rows: ReplayRow[] = []
  const acts: ReplayedAct[] = []

  for (const [index, event] of events.entries()) {
    if (event.type !== 'tool-called') continue

    const weighed = await weigh({
      event,
      before: events.slice(0, index + 1),
      lens,
      deps,
      signal,
    })

    acts.push(weighed.act)
    rows.push({
      seq: event.seq,
      callId: event.callId,
      toolName: event.name,
      deeds: weighed.deeds,
      evidence: weighed.evidence,
      judged: weighed.judged,
      consultation: weighed.consultation,
      grantCleared: weighed.grantCleared,
      askedThen: asked.has(event.callId),
      undone: undefined,
    })
  }

  return {
    threadId: deps.threadId,
    projectDirectory: deps.projectDirectory,
    turns: eventsOfType({ events, type: 'user-said' }).length,
    calls: rows.length,
    rows: withMisses({ rows, acts, events }),
  }
}

function withMisses({
  rows,
  acts,
  events,
}: {
  rows: readonly ReplayRow[]
  acts: readonly ReplayedAct[]
  events: readonly Event[]
}): readonly ReplayRow[] {
  const said = operatorUtterances({ events, limit: events.length })

  return rows.map((row, index) => {
    if (row.judged?.wouldAsk === true) return row

    const candidate = acts[index]
    if (candidate === undefined) return row

    return { ...row, undone: undoingAfter({ candidate, acts, said }) }
  })
}
