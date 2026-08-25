import {
  assemble,
  awaitsReply,
  estimateTokens,
  outstandingApproval,
  pendingCalls,
  type Annotator,
  type Assembled,
  type BranchId,
  type ChunkFilter,
  type EventDraft,
  type EventLogPort,
  type IdPort,
  type ModelPort,
  type ModelStepResult,
  type Rule,
  type RuleContext,
  type ToolDeclaration,
} from '@dltech/atlas-core'

import { ModelStreamError } from '../model/errors'
import { ETurnStatus, type TurnOutcome } from './turn-outcome'

export type TurnDeps = {
  log: EventLogPort
  model: ModelPort
  ids: IdPort
  rules: readonly Rule[]
  annotators?: readonly Annotator[] | undefined
  tools?: readonly ToolDeclaration[] | undefined
  maxSteps?: number | undefined
  countTokens?: ((assembled: Assembled) => number) | undefined
  onChunk?: ChunkFilter | undefined
}

export type TurnRunner = {
  say(args: { branchId: BranchId; text: string; signal?: AbortSignal }): Promise<TurnOutcome>
  runTurn(args: { branchId: BranchId; signal?: AbortSignal }): Promise<TurnOutcome>
}

const DEFAULT_MAX_STEPS = 16

type SteppedTurn = { ok: true; result: ModelStepResult } | { ok: false; message: string; cause: unknown }

function interruptedDraft(result: ModelStepResult): EventDraft | undefined {
  if (result.parts.length === 0) return undefined
  return { type: 'assistant-said', parts: result.parts, interrupted: true }
}

function draftsFor(result: ModelStepResult): EventDraft[] {
  const drafts: EventDraft[] = []
  if (result.parts.length > 0) drafts.push({ type: 'assistant-said', parts: result.parts })

  result.toolCalls.forEach((call, ordinal) => {
    drafts.push({ type: 'tool-called', callId: call.callId, name: call.name, input: call.input, ordinal })
  })

  return drafts
}

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
  const maxSteps = deps.maxSteps ?? DEFAULT_MAX_STEPS
  const countTokens = deps.countTokens ?? estimateTokens

  const runTurn = async ({
    branchId,
    signal,
  }: {
    branchId: BranchId
    signal?: AbortSignal
  }): Promise<TurnOutcome> => {
    const runId = deps.ids.nextRunId()
    const abortSignal = signal ?? new AbortController().signal
    let previous: Assembled | undefined

    for (let step = 0; step < maxSteps; step += 1) {
      const events = await deps.log.read({ branchId })

      const waiting = outstandingApproval(events)
      if (waiting !== undefined) {
        return { status: ETurnStatus.Paused, runId, callId: waiting, reason: 'awaiting approval' }
      }

      const pending = pendingCalls(events)[0]
      if (pending !== undefined) {
        return { status: ETurnStatus.Paused, runId, callId: pending.callId, reason: `awaiting ${pending.name}` }
      }

      if (!awaitsReply(events)) return { status: ETurnStatus.Idle, runId }

      const ctx: RuleContext = {
        events,
        branchId,
        step,
        provider: deps.model.identity,
        countTokens,
        ...(previous === undefined ? {} : { previous }),
      }

      const { assembled } = assemble({
        rules: deps.rules,
        ctx,
        ...(deps.annotators === undefined ? {} : { annotators: deps.annotators }),
      })
      previous = assembled

      const stepped = await takeModelStep({
        model: deps.model,
        assembled,
        tools,
        signal: abortSignal,
        onChunk: deps.onChunk,
      })

      if (!stepped.ok) {
        return { status: ETurnStatus.Failed, runId, message: stepped.message, cause: stepped.cause }
      }

      if (abortSignal.aborted) {
        const interrupted = interruptedDraft(stepped.result)
        if (interrupted !== undefined) await deps.log.append({ branchId, runId, drafts: [interrupted] })
        return { status: ETurnStatus.Interrupted, runId }
      }

      const drafts = draftsFor(stepped.result)
      if (drafts.length > 0) await deps.log.append({ branchId, runId, drafts })

      if (stepped.result.toolCalls.length > 0) continue

      return { status: ETurnStatus.Completed, runId }
    }

    return { status: ETurnStatus.Exhausted, runId }
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
