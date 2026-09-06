import {
  EApprovalResolution,
  isConcurrencySafeCall,
  partitionToolCalls,
  pendingCalls,
  resolveApproval,
  rowsOwnedBy,
  activeWorktreeAfter,
  activeWorktreeOf,
  homeDirectoryAfter,
  homeDirectoryOf,
  type ActiveWorktree,
  type ThreadId,
  type CallId,
  type Event,
  type EventDraft,
  type EventLogPort,
  type ToolDeclaration,
  type ToolOutputChunk,
} from '@dltech/atlas-core'

import type { DispatchableCall, ToolDispatcher } from '../tools/dispatch'

export type ToolOutputNotice = ToolOutputChunk & { callId: CallId }

export type OnToolOutputNotice = (args: ToolOutputNotice) => void

export type SettlePending = (args: {
  threadId: ThreadId
  signal: AbortSignal
}) => Promise<{ paused?: { callId: CallId; reason: string } }>

export function createSettlePending(deps: {
  log: EventLogPort
  dispatch: ToolDispatcher
  tools?: (() => readonly ToolDeclaration[]) | undefined
  launchDirectory?: string | undefined
  onToolOutput?: OnToolOutputNotice | undefined
}): SettlePending {
  const isSafe = (call: DispatchableCall): boolean => {
    const declarations = new Map((deps.tools?.() ?? []).map((tool) => [tool.name, tool]))
    return isConcurrencySafeCall({ declaration: declarations.get(call.name), input: call.input })
  }

  const settleOne = async (args: {
    call: DispatchableCall
    refusal: string | undefined
    events: readonly Event[]
    signal: AbortSignal
    projectDirectory: string
    homeDirectory: string
    activeWorktree: ActiveWorktree | undefined
  }): Promise<readonly EventDraft[]> => {
    const { call, refusal } = args

    if (refusal !== undefined) {
      return [{ type: 'tool-denied', callId: call.callId, name: call.name, reason: refusal }]
    }

    const tap = deps.onToolOutput
    return deps.dispatch.dispatch({
      call,
      signal: args.signal,
      projectDirectory: args.projectDirectory,
      homeDirectory: args.homeDirectory,
      activeWorktree: args.activeWorktree,
      events: args.events,
      ...(tap === undefined
        ? {}
        : { onOutput: (chunk: ToolOutputChunk) => tap({ callId: call.callId, ...chunk }) }),
    })
  }

  return async ({ threadId, signal }) => {
    const events = await deps.log.read({ threadId })
    const owned = rowsOwnedBy({ events, threadId })
    const refusals = new Map<CallId, string>()

    const calls = [...pendingCalls(owned)]
      .sort((left, right) => left.ordinal - right.ordinal)
      .map((call) => {
        const answered = resolveApproval({ events: owned, callId: call.callId, input: call.input })
        if (answered.resolution === EApprovalResolution.Dispatch) {
          return { ...call, input: answered.input }
        }

        refusals.set(call.callId, answered.reason)
        return call
      })

    const runs = partitionToolCalls({ calls, isSafe })

    const launchDirectory = deps.launchDirectory ?? process.cwd()
    let activeWorktree: ActiveWorktree | undefined = activeWorktreeOf(events)
    let homeDirectory = homeDirectoryOf({ events, launchDirectory })

    for (const run of runs) {
      if (signal.aborted) return {}

      const projectDirectory = activeWorktree?.path ?? homeDirectory
      const settled = await Promise.all(
        run.map((call) =>
          settleOne({
            call,
            refusal: refusals.get(call.callId),
            events,
            signal,
            projectDirectory,
            homeDirectory,
            activeWorktree,
          }),
        ),
      )

      for (const [index, drafts] of settled.entries()) {
        const call = run[index]
        if (call === undefined || drafts.length === 0) continue
        await deps.log.append({ threadId, runId: call.runId, drafts })
      }

      const drafts = settled.flat()

      activeWorktree = activeWorktreeAfter({ drafts, active: activeWorktree })
      homeDirectory = homeDirectoryAfter({ drafts, home: homeDirectory })

      const asked = drafts.find((draft) => draft.type === 'approval-requested')
      if (asked !== undefined) return { paused: { callId: asked.callId, reason: asked.reason } }
    }

    return {}
  }
}
