import { EBlockKind, type Event } from '@dltech/atlas-core'
import { ESandboxState, EStepEnd, type StepSignal, type TurnSpend } from '@dltech/atlas-harness'

import { durableEntries } from './durable-entries'
import { liveSteps, runKey, stepsOfSignals, type InFlightStep } from './in-flight-steps'
import { revealedText, type RevealGate } from './reveal'
import { modelEntries } from './model-entries'
import { liveToolRuns, type LiveToolRun } from './tool-runs'
import {
  foldThoughts,
  SHIPPED_THINKING,
  toolsAboveThoughts,
  type EThinkingVisibility,
} from './thinking-fold'
import type { SidebarContainer } from './sidebar-model'
import {
  EAuthor,
  EEntryKind,
  EMPTY_TRANSCRIPT,
  toolsRanEntry,
  type SandboxNoticeEntry,
  type StepFailure,
  type TranscriptEntry,
  type TranscriptModel,
} from './transcript-model'

const failureOf = (steps: readonly InFlightStep[]): StepFailure | null => {
  const failed = steps.filter((step) => step.end === EStepEnd.Failed).at(-1)
  return failed === undefined ? null : { message: failed.errorMessage }
}

function saidInStep(args: { step: InFlightStep; reveal: RevealGate | null }): TranscriptEntry[] {
  return modelEntries({
    runs: args.step.blocks.map((block) => {
      const key = runKey({ stepId: args.step.stepId, kind: block.kind, id: block.id })
      return {
        key,
        text: revealedText({ key, text: block.text, gate: args.reveal }),
        isReasoning: block.kind === EBlockKind.Reasoning,
      }
    }),
    streaming: args.step.end === null,
    interruptedAtEnd: args.step.end === EStepEnd.Interrupted,
  })
}

function interleaved(args: {
  said: readonly TranscriptEntry[]
  runs: readonly LiveToolRun[]
}): TranscriptEntry[] {
  const entries: TranscriptEntry[] = []
  let cursor = 0

  for (const { run, precededByBlocks } of args.runs) {
    const upTo = Math.max(cursor, Math.min(precededByBlocks, args.said.length))
    entries.push(...args.said.slice(cursor, upTo), toolsRanEntry(run))
    cursor = upTo
  }

  entries.push(...args.said.slice(cursor))
  return entries
}

function entriesOfStep(args: { step: InFlightStep; reveal: RevealGate | null }): TranscriptEntry[] {
  return interleaved({
    said: saidInStep(args),
    runs: liveToolRuns(args.step.calls),
  })
}

const SANDBOX_NOTICE_KEY = 'sandbox-notice'

function sandboxNoticeOf(sandbox: SidebarContainer | null): SandboxNoticeEntry[] {
  if (sandbox === null) return []

  const shared = {
    kind: EEntryKind.SandboxNotice,
    author: EAuthor.Model,
    key: SANDBOX_NOTICE_KEY,
  } as const

  if (sandbox.state === ESandboxState.Starting) {
    return [
      {
        ...shared,
        text: `starting the container — ${sandbox.image} can take minutes to pull the first time`,
        failed: false,
      },
    ]
  }
  if (sandbox.state === ESandboxState.Failed) {
    return [
      {
        ...shared,
        text: `the container failed to start: ${sandbox.reason ?? 'the daemon gave no reason'}`,
        failed: true,
      },
    ]
  }
  return []
}

export function assembleTranscript(args: {
  durable: readonly TranscriptEntry[]
  live: readonly InFlightStep[]
  reveal?: RevealGate | null
  thinking?: EThinkingVisibility
  pendingTldr?: { anchorSeq: number; text: string } | null | undefined
  tldrStatus?: boolean | undefined
  sandbox?: SidebarContainer | null | undefined
}): TranscriptModel {
  const reveal = args.reveal ?? null
  const pending = args.pendingTldr ?? null
  const entries = [
    ...foldThoughts({
      entries: withTldrStatus({
        entries: withPendingTldr({
          entries: toolsAboveThoughts([
            ...args.durable,
            ...args.live.flatMap((step) => entriesOfStep({ step, reveal })),
          ]),
          pending,
        }),
        enabled: args.tldrStatus ?? true,
      }),
      visibility: args.thinking ?? SHIPPED_THINKING,
    }),
    ...sandboxNoticeOf(args.sandbox ?? null),
  ]
  const streaming = args.live.some((step) => step.end === null)
  const failure = failureOf(args.live)

  if (entries.length === 0 && !streaming && failure === null) {
    return EMPTY_TRANSCRIPT
  }

  return { entries, isEmpty: entries.length === 0, streaming, failure }
}

export function deriveTranscript(args: {
  events: readonly Event[]
  signals: readonly StepSignal[]
  turns?: readonly TurnSpend[] | undefined
  reveal?: RevealGate | null
  thinking?: EThinkingVisibility
  pendingTldr?: { anchorSeq: number; text: string } | null | undefined
  tldrStatus?: boolean | undefined
  sandbox?: SidebarContainer | null | undefined
}): TranscriptModel {
  return assembleTranscript({
    durable: durableEntries({ events: args.events, turns: args.turns }),
    live: liveSteps({ steps: stepsOfSignals(args.signals), events: args.events }),
    ...(args.reveal === undefined ? {} : { reveal: args.reveal }),
    ...(args.thinking === undefined ? {} : { thinking: args.thinking }),
    ...(args.pendingTldr === undefined ? {} : { pendingTldr: args.pendingTldr }),
    ...(args.tldrStatus === undefined ? {} : { tldrStatus: args.tldrStatus }),
    ...(args.sandbox === undefined ? {} : { sandbox: args.sandbox }),
  })
}

function withTldrStatus(args: {
  entries: readonly TranscriptEntry[]
  enabled: boolean
}): TranscriptEntry[] {
  if (args.enabled) return [...args.entries]

  return args.entries.map((entry) =>
    entry.kind === EEntryKind.TldrWritten && entry.status !== undefined
      ? { ...entry, status: undefined }
      : entry,
  )
}

const PENDING_TLDR_KEY = 'tldr-pending'

function withPendingTldr(args: {
  entries: readonly TranscriptEntry[]
  pending: { anchorSeq: number; text: string } | null
}): TranscriptEntry[] {
  const { pending } = args
  if (pending === null) return [...args.entries]

  const entries = args.entries.filter(
    (entry) => !(entry.kind === EEntryKind.TldrWritten && entry.anchorSeq === pending.anchorSeq),
  )
  const footer: TranscriptEntry = {
    kind: EEntryKind.TldrWritten,
    author: EAuthor.Model,
    key: PENDING_TLDR_KEY,
    text: pending.text,
    anchorSeq: pending.anchorSeq,
    throughSeq: 0,
    streaming: true,
  }

  for (let index = entries.length - 1; index >= 0; index--) {
    if (entries[index]?.kind === EEntryKind.TurnEnded) {
      return [...entries.slice(0, index), footer, ...entries.slice(index)]
    }
  }
  return [...entries, footer]
}
