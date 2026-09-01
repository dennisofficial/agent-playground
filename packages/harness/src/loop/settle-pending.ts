import {
  EApprovalResolution,
  isConcurrencySafeCall,
  partitionToolCalls,
  pendingCalls,
  resolveApproval,
  rowsOwnedBy,
  projectDirectoryOf,
  type ThreadId,
  type CallId,
  type Event,
  type EventDraft,
  type EventLogPort,
  type ToolDeclaration,
} from '@dltech/atlas-core'

import type { DispatchableCall, ToolDispatcher } from '../tools/dispatch'

export type SettlePending = (args: {
  threadId: ThreadId
  signal: AbortSignal
}) => Promise<{ paused?: { callId: CallId; reason: string } }>

function projectDirectoryAfter(args: {
  drafts: readonly EventDraft[]
  launchDirectory: string
  projectDirectory: string
}): string {
  for (let index = args.drafts.length - 1; index >= 0; index -= 1) {
    const draft = args.drafts[index]
    if (draft?.type === 'worktree-entered') return draft.path
    if (draft?.type === 'worktree-exited') return args.launchDirectory
  }

  return args.projectDirectory
}

export function createSettlePending(deps: {
  log: EventLogPort
  dispatch: ToolDispatcher
  tools?: readonly ToolDeclaration[] | undefined
  launchDirectory?: string | undefined
}): SettlePending {
  const declarations = new Map((deps.tools ?? []).map((tool) => [tool.name, tool]))

  const isSafe = (call: DispatchableCall): boolean =>
    isConcurrencySafeCall({ declaration: declarations.get(call.name), input: call.input })

  const settleOne = async (args: {
    call: DispatchableCall
    refusal: string | undefined
    events: readonly Event[]
    signal: AbortSignal
    projectDirectory: string
  }): Promise<readonly EventDraft[]> => {
    const { call, refusal } = args

    if (refusal !== undefined) {
      return [{ type: 'tool-denied', callId: call.callId, name: call.name, reason: refusal }]
    }

    return deps.dispatch.dispatch({
      call,
      signal: args.signal,
      projectDirectory: args.projectDirectory,
      events: args.events,
    })
  }

  return async ({ threadId, signal }) => {
    const events = await deps.log.read({ threadId })
    const owned = rowsOwnedBy({ events, threadId })
    const refusals = new Map<CallId, string>()

    const calls = [...pendingCalls(owned)]
      .sort((left, right) => left.ordinal - right.ordinal)
      .map((call) => {
        const answered = resolveApproval({ events: owned, callId: call.callId })
        if (answered.resolution === EApprovalResolution.Dispatch) {
          return { ...call, input: answered.input }
        }

        refusals.set(call.callId, answered.reason)
        return call
      })

    const runs = partitionToolCalls({ calls, isSafe })

    const launchDirectory = deps.launchDirectory ?? process.cwd()
    let projectDirectory = projectDirectoryOf({ events, launchDirectory })

    for (const run of runs) {
      if (signal.aborted) return {}

      const settled = await Promise.all(
        run.map((call) =>
          settleOne({
            call,
            refusal: refusals.get(call.callId),
            events,
            signal,
            projectDirectory,
          }),
        ),
      )

      for (const [index, drafts] of settled.entries()) {
        const call = run[index]
        if (call === undefined || drafts.length === 0) continue
        await deps.log.append({ threadId, runId: call.runId, drafts })
      }

      const drafts = settled.flat()

      projectDirectory = projectDirectoryAfter({ drafts, launchDirectory, projectDirectory })

      const asked = drafts.find((draft) => draft.type === 'approval-requested')
      if (asked !== undefined) return { paused: { callId: asked.callId, reason: asked.reason } }
    }

    return {}
  }
}
