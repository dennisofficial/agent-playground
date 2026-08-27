import {
  assemble,
  awaitsReply,
  estimateTokens,
  exchangeFaults,
  outstandingApproval,
  pendingCalls,
  type Assembled,
  type AssemblyPipeline,
  type BranchId,
  type CallId,
  type ChunkFilter,
  type EventDraft,
  type EventLogPort,
  type IdPort,
  type ModelPort,
  type ModelStepResult,
  type ExchangeFault,
  type RuleContext,
  type RunId,
  type ToolDeclaration,
} from '@dltech/atlas-core'

import type { HookChain } from '../hooks/registry'
import { ModelStreamError } from '../model/errors'
import type { Dispatch } from '../tools/dispatch'
import { openTurnSpend, TURN_CRASHED, type TurnLedgerDeps, type TurnSpendTally } from '../ledger/record-turn-spend'
import { createSettlePending } from './settle-pending'
import { draftsFor, interruptedDrafts } from './step-drafts'
import { committedSinceLastMessage, messageArrivedSince } from './turn-position'
import { ETurnStatus, type TurnOutcome } from './turn-outcome'

export type TurnDeps = {
  log: EventLogPort
  model: ModelPort
  ids: IdPort
  assembly: AssemblyPipeline
  tools?: readonly ToolDeclaration[] | undefined
  countTokens?: ((assembled: Assembled) => number) | undefined
  onChunk?: ChunkFilter | undefined
  dispatch?: Dispatch | undefined
  hooks?: HookChain | undefined
  drainPending?: (() => Promise<readonly string[]>) | undefined
  spend?: TurnLedgerDeps | undefined
}



export type TurnRunner = {
  say(args: { branchId: BranchId; text: string; signal?: AbortSignal }): Promise<TurnOutcome>
  runTurn(args: { branchId: BranchId; signal?: AbortSignal }): Promise<TurnOutcome>
}

type SteppedTurn = { ok: true; result: ModelStepResult } | { ok: false; message: string; cause: unknown }

const faultLine = (fault: ExchangeFault): string =>
  `message ${fault.messageIndex}: ${fault.detail} (event ${fault.origin.eventId})`

const stalledReport = (call: { callId: CallId; name: string }): string =>
  `dispatch left ${call.name} (${call.callId}) pending without settling it — the turn would spin forever`

const faultReport = (faults: readonly ExchangeFault[]): string =>
  `the assembled prompt is one Atlas must not send — ${faults.map(faultLine).join('; ')}`

async function takeModelStep(args: {
  model: ModelPort
  assembled: Assembled
  tools: readonly ToolDeclaration[]
  signal: AbortSignal
  onChunk?: ChunkFilter | undefined
}): Promise<SteppedTurn> {
  try {
    const result = await args.model.step({
      assembled: args.assembled,
      tools: args.tools,
      signal: args.signal,
      ...(args.onChunk === undefined ? {} : { onChunk: args.onChunk }),
    })
    return { ok: true, result }
  } catch (error) {
    if (error instanceof ModelStreamError) return { ok: false, message: error.message, cause: error.cause }
    throw error
  }
}

export function createTurnRunner(deps: TurnDeps): TurnRunner {
  const tools = deps.tools ?? []
  const countTokens = deps.countTokens ?? estimateTokens
  const settlePending =
    deps.dispatch === undefined
      ? undefined
      : createSettlePending({ log: deps.log, dispatch: deps.dispatch, tools })

  const drainInto = async ({ branchId }: { branchId: BranchId }): Promise<boolean> => {
    if (deps.drainPending === undefined) return false

    const waiting = await deps.drainPending()
    if (waiting.length === 0) return false

    await deps.log.append({
      branchId,
      runId: deps.ids.nextRunId(),
      drafts: waiting.map((text): EventDraft => ({ type: 'user-said', text })),
    })
    return true
  }

  const trackedTurn = async ({
    branchId,
    signal,
    runId,
    spend,
  }: {
    branchId: BranchId
    signal?: AbortSignal
    runId: RunId
    spend: TurnSpendTally
  }): Promise<TurnOutcome> => {
    const abortSignal = signal ?? new AbortController().signal
    let previous: Assembled | undefined
    let modelSteps = 0
    let seenThrough: number | undefined
    let settleAttempted: CallId | undefined

    const interrupted = async (): Promise<TurnOutcome> => ({
      status: ETurnStatus.Interrupted,
      runId,
      committed: committedSinceLastMessage(await deps.log.read({ branchId })),
    })

    for (;;) {
      const beforeDrain = await deps.log.read({ branchId })

      const waiting = outstandingApproval(beforeDrain)
      if (waiting !== undefined) {
        return { status: ETurnStatus.Paused, runId, callId: waiting, reason: 'awaiting approval' }
      }

      const pending = pendingCalls(beforeDrain)[0]
      if (pending !== undefined) {
        if (settlePending === undefined) {
          return { status: ETurnStatus.Paused, runId, callId: pending.callId, reason: `awaiting ${pending.name}` }
        }
        if (pending.callId === settleAttempted) {
          return { status: ETurnStatus.Failed, runId, message: stalledReport(pending), cause: pending }
        }

        settleAttempted = pending.callId
        const settled = await settlePending({ branchId, signal: abortSignal })
        if (settled.paused !== undefined) return { status: ETurnStatus.Paused, runId, ...settled.paused }
        if (abortSignal.aborted) return interrupted()
        continue
      }

      const events = (await drainInto({ branchId })) ? await deps.log.read({ branchId }) : beforeDrain

      if (!awaitsReply(events) && !messageArrivedSince({ events, seenThrough })) {
        return { status: ETurnStatus.Idle, runId }
      }

      seenThrough = events.at(-1)?.seq

      const ctx: RuleContext = {
        events,
        branchId,
        step: modelSteps,
        provider: deps.model.identity,
        countTokens,
        ...(previous === undefined ? {} : { previous }),
      }

      const { assembled: projected, trace } = assemble({
        rules: deps.assembly.rules,
        annotators: deps.assembly.annotators,
        ctx,
      })

      const assembled = (await deps.hooks?.beforeStep({ assembled: projected, trace })) ?? projected
      previous = assembled

      const faults = exchangeFaults(assembled)
      if (faults.length > 0) {
        return { status: ETurnStatus.Failed, runId, message: faultReport(faults), cause: faults }
      }

      const stepped = await takeModelStep({
        model: deps.model,
        assembled,
        tools,
        signal: abortSignal,
        onChunk: deps.onChunk,
      })

      modelSteps += 1
      settleAttempted = undefined

      spend.countStep(stepped.ok ? stepped.result.usage : undefined)

      if (!stepped.ok) {
        return { status: ETurnStatus.Failed, runId, message: stepped.message, cause: stepped.cause }
      }

      if (abortSignal.aborted) {
        const abandoned = interruptedDrafts(stepped.result)
        if (abandoned.length > 0) await deps.log.append({ branchId, runId, drafts: abandoned })
        return interrupted()
      }

      const drafts = draftsFor(stepped.result)
      if (drafts.length > 0) await deps.log.append({ branchId, runId, drafts })

      if (stepped.result.toolCalls.length > 0) continue

      const latest = await deps.log.read({ branchId })
      if (messageArrivedSince({ events: latest, seenThrough })) continue
      if (await drainInto({ branchId })) continue

      const closing = (await deps.hooks?.afterTurn({ branchId })) ?? []
      if (closing.length > 0) await deps.log.append({ branchId, runId, drafts: closing })

      return { status: ETurnStatus.Completed, runId }
    }
  }

  const runTurn = async ({
    branchId,
    signal,
  }: {
    branchId: BranchId
    signal?: AbortSignal
  }): Promise<TurnOutcome> => {
    const runId = deps.ids.nextRunId()
    const spend = openTurnSpend({ ...(deps.spend ?? {}), model: deps.model.identity })
    let status: string = TURN_CRASHED

    try {
      const outcome = await trackedTurn({
        branchId,
        runId,
        spend,
        ...(signal === undefined ? {} : { signal }),
      })
      status = outcome.status
      return outcome
    } finally {
      await spend.settle({ branchId, runId, status })
    }
  }

  return {
    async say({ branchId, text, signal }) {
      await deps.log.append({
        branchId,
        runId: deps.ids.nextRunId(),
        drafts: [{ type: 'user-said', text }],
      })
      return runTurn({ branchId, ...(signal === undefined ? {} : { signal }) })
    },

    runTurn,
  }
}
