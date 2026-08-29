import {
  assemble,
  AUTO_COMPACT_OFF,
  autoCompactBeforeStep,
  EAutoCompact,
  modelEntry,
  overflowsWindow,
  awaitsReply,
  estimateTokens,
  exchangeFaults,
  outstandingApproval,
  pendingCalls,
  type Assembled,
  type AssemblyPipeline,
  type ThreadId,
  type CallId,
  type ChunkFilter,
  type EventDraft,
  type EventLogPort,
  type IdPort,
  type ModelPort,
  type RuleContext,
  type RunId,
  type ToolDeclaration,
} from '@dltech/atlas-core'

import type { HookChain } from '../hooks/registry'
import type { ToolDispatcher } from '../tools/dispatch'
import { takeModelStep } from './model-step'
import { openTurnSpend, TURN_CRASHED, type TurnLedgerDeps, type TurnSpendTally } from '../ledger/record-turn-spend'
import { appendResumeDrafts } from './resume-turn'
import { createSettlePending, type SettlePending } from './settle-pending'
import { draftsFor, interruptedDrafts } from './step-drafts'
import { faultReport, overflowReport, stalledReport } from './turn-faults'
import { committedSinceLastMessage, messageArrivedSince } from './turn-position'
import { ETurnStatus, type TurnOutcome } from './turn-outcome'
import { TurnRunner } from './turn-runner.port'

export type TurnDeps = {
  log: EventLogPort
  model: ModelPort
  ids: IdPort
  assembly: AssemblyPipeline
  tools?: readonly ToolDeclaration[] | undefined
  countTokens?: ((assembled: Assembled) => number) | undefined
  onChunk?: ChunkFilter | undefined
  dispatch?: ToolDispatcher | undefined
  hooks?: HookChain | undefined
  drainPending?: (() => Promise<readonly EventDraft[]>) | undefined
  spend?: TurnLedgerDeps | undefined
  compact?: ((args: { threadId: ThreadId }) => Promise<boolean>) | undefined
  autoCompactAtPercent?: (() => number) | undefined
  projectDirectory?: string | undefined
}

export class LoopTurnRunner extends TurnRunner {
  private readonly log: EventLogPort
  private readonly model: ModelPort
  private readonly ids: IdPort
  private readonly assembly: AssemblyPipeline
  private readonly tools: readonly ToolDeclaration[]
  private readonly countTokens: (assembled: Assembled) => number
  private readonly onChunk: ChunkFilter | undefined
  private readonly hooks: HookChain | undefined
  private readonly drainPending: (() => Promise<readonly EventDraft[]>) | undefined
  private readonly spend: TurnLedgerDeps | undefined
  private readonly settlePending: SettlePending | undefined
  private readonly compact: ((args: { threadId: ThreadId }) => Promise<boolean>) | undefined
  private readonly autoCompactAtPercent: () => number

  constructor(deps: TurnDeps) {
    super()
    this.log = deps.log
    this.model = deps.model
    this.ids = deps.ids
    this.assembly = deps.assembly
    this.tools = deps.tools ?? []
    this.countTokens = deps.countTokens ?? estimateTokens
    this.onChunk = deps.onChunk
    this.hooks = deps.hooks
    this.drainPending = deps.drainPending
    this.spend = deps.spend
    this.compact = deps.compact
    this.autoCompactAtPercent = deps.autoCompactAtPercent ?? (() => AUTO_COMPACT_OFF)
    this.settlePending =
      deps.dispatch === undefined
        ? undefined
        : createSettlePending({
            log: deps.log,
            dispatch: deps.dispatch,
            tools: this.tools,
            projectDirectory: deps.projectDirectory,
          })
  }

  async say({
    threadId,
    text,
    signal,
  }: {
    threadId: ThreadId
    text: string
    signal?: AbortSignal
  }): Promise<TurnOutcome> {
    await this.log.append({
      threadId,
      runId: this.ids.nextRunId(),
      drafts: [{ type: 'user-said', text }],
    })
    return this.runTurn({ threadId, ...(signal === undefined ? {} : { signal }) })
  }

  async resume({ threadId, signal }: { threadId: ThreadId; signal?: AbortSignal }): Promise<TurnOutcome> {
    await appendResumeDrafts({ log: this.log, ids: this.ids, threadId })
    return this.runTurn({ threadId, ...(signal === undefined ? {} : { signal }) })
  }

  async runTurn({ threadId, signal }: { threadId: ThreadId; signal?: AbortSignal }): Promise<TurnOutcome> {
    const runId = this.ids.nextRunId()
    const spend = openTurnSpend({ ...(this.spend ?? {}), model: this.model.identity })
    let status: string = TURN_CRASHED

    try {
      const outcome = await this.trackedTurn({
        threadId,
        runId,
        spend,
        ...(signal === undefined ? {} : { signal }),
      })
      status = outcome.status
      return outcome
    } finally {
      await spend.settle({ threadId, runId, status })
    }
  }

  private async drainInto({ threadId }: { threadId: ThreadId }): Promise<boolean> {
    if (this.drainPending === undefined) return false

    const waiting = await this.drainPending()
    if (waiting.length === 0) return false

    await this.log.append({ threadId, runId: this.ids.nextRunId(), drafts: waiting })
    return true
  }

  private async trackedTurn({
    threadId,
    signal,
    runId,
    spend,
  }: {
    threadId: ThreadId
    signal?: AbortSignal
    runId: RunId
    spend: TurnSpendTally
  }): Promise<TurnOutcome> {
    const abortSignal = signal ?? new AbortController().signal
    let previous: Assembled | undefined
    let modelSteps = 0
    let seenThrough: number | undefined
    let settleAttempted: CallId | undefined
    let compacted = false

    const interrupted = async (): Promise<TurnOutcome> => ({
      status: ETurnStatus.Interrupted,
      runId,
      committed: committedSinceLastMessage(await this.log.read({ threadId })),
    })

    const opening = (await this.hooks?.beforeTurn({ threadId })) ?? []
    if (opening.length > 0) await this.log.append({ threadId, runId, drafts: opening })

    for (;;) {
      const beforeDrain = await this.log.read({ threadId })

      const waiting = outstandingApproval(beforeDrain)
      if (waiting !== undefined) {
        return { status: ETurnStatus.Paused, runId, callId: waiting, reason: 'awaiting approval' }
      }

      const pending = pendingCalls(beforeDrain)[0]
      if (pending !== undefined) {
        if (this.settlePending === undefined) {
          return { status: ETurnStatus.Paused, runId, callId: pending.callId, reason: `awaiting ${pending.name}` }
        }
        if (pending.callId === settleAttempted) {
          return { status: ETurnStatus.Failed, runId, message: stalledReport(pending), cause: pending }
        }

        settleAttempted = pending.callId
        const settled = await this.settlePending({ threadId, signal: abortSignal })
        if (settled.paused !== undefined) return { status: ETurnStatus.Paused, runId, ...settled.paused }
        if (abortSignal.aborted) return interrupted()
        continue
      }

      const events = (await this.drainInto({ threadId })) ? await this.log.read({ threadId }) : beforeDrain

      if (!awaitsReply(events) && !messageArrivedSince({ events, seenThrough })) {
        return { status: ETurnStatus.Idle, runId }
      }

      seenThrough = events.at(-1)?.seq

      const ctx: RuleContext = {
        events,
        threadId,
        step: modelSteps,
        provider: this.model.identity,
        countTokens: this.countTokens,
        ...(previous === undefined ? {} : { previous }),
      }

      const { assembled: projected, trace } = assemble({
        rules: this.assembly.rules,
        annotators: this.assembly.annotators,
        ctx,
      })

      const assembled = (await this.hooks?.beforeStep({ assembled: projected, trace })) ?? projected
      previous = assembled

      const tokens = this.countTokens(assembled)
      const window = modelEntry(this.model.identity.modelId)?.contextWindow ?? 0

      if (
        autoCompactBeforeStep({ tokens, window, atPercent: this.autoCompactAtPercent() }) ===
          EAutoCompact.BeforeOverflow &&
        !compacted &&
        this.compact !== undefined
      ) {
        compacted = true
        if (await this.compact({ threadId })) {
          previous = undefined
          continue
        }
      }

      if (overflowsWindow({ tokens, window })) {
        return {
          status: ETurnStatus.Failed,
          runId,
          message: overflowReport({ tokens, window }),
          cause: { tokens, window },
        }
      }

      const faults = exchangeFaults(assembled)
      if (faults.length > 0) {
        return { status: ETurnStatus.Failed, runId, message: faultReport(faults), cause: faults }
      }

      const stepped = await takeModelStep({
        model: this.model,
        tools: this.tools,
        onChunk: this.onChunk,
        assembled,
        signal: abortSignal,
      })

      modelSteps += 1
      settleAttempted = undefined

      spend.countStep(stepped.ok ? stepped.result.usage : undefined)

      if (!stepped.ok) {
        return { status: ETurnStatus.Failed, runId, message: stepped.message, cause: stepped.cause }
      }

      if (abortSignal.aborted) {
        const abandoned = interruptedDrafts(stepped.result)
        if (abandoned.length > 0) await this.log.append({ threadId, runId, drafts: abandoned })
        return interrupted()
      }

      const drafts = draftsFor(stepped.result)
      if (drafts.length > 0) await this.log.append({ threadId, runId, drafts })

      if (stepped.result.toolCalls.length > 0) continue

      const latest = await this.log.read({ threadId })
      if (messageArrivedSince({ events: latest, seenThrough })) continue
      if (await this.drainInto({ threadId })) continue

      const closing = (await this.hooks?.afterTurn({ threadId })) ?? []
      if (closing.length > 0) await this.log.append({ threadId, runId, drafts: closing })

      return { status: ETurnStatus.Completed, runId }
    }
  }
}
