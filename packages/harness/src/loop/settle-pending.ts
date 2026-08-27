import {
  isConcurrencySafeCall,
  partitionToolCalls,
  pendingCalls,
  type BranchId,
  type CallId,
  type EventLogPort,
  type ToolDeclaration,
} from '@dltech/atlas-core'

import type { DispatchableCall, ToolDispatcher } from '../tools/dispatch'

export type SettlePending = (args: {
  branchId: BranchId
  signal: AbortSignal
}) => Promise<{ paused?: { callId: CallId; reason: string } }>

export function createSettlePending(deps: {
  log: EventLogPort
  dispatch: ToolDispatcher
  tools?: readonly ToolDeclaration[] | undefined
}): SettlePending {
  const declarations = new Map((deps.tools ?? []).map((tool) => [tool.name, tool]))

  const isSafe = (call: DispatchableCall): boolean =>
    isConcurrencySafeCall({ declaration: declarations.get(call.name), input: call.input })

  return async ({ branchId, signal }) => {
    const events = await deps.log.read({ branchId })
    const calls = [...pendingCalls(events)].sort((left, right) => left.ordinal - right.ordinal)

    const runs = partitionToolCalls({ calls, isSafe })

    for (const run of runs) {
      if (signal.aborted) return {}

      const settled = await Promise.all(run.map((call) => deps.dispatch.dispatch({ call, signal })))

      for (const [index, drafts] of settled.entries()) {
        const call = run[index]
        if (call === undefined || drafts.length === 0) continue
        await deps.log.append({ branchId, runId: call.runId, drafts })
      }

      const asked = settled.flat().find((draft) => draft.type === 'approval-requested')
      if (asked !== undefined) return { paused: { callId: asked.callId, reason: asked.reason } }
    }

    return {}
  }
}
