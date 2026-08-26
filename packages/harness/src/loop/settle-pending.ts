import { pendingCalls, type BranchId, type CallId, type EventLogPort } from '@dltech/atlas-core'

import type { Dispatch } from '../tools/dispatch'

export type SettlePending = (args: {
  branchId: BranchId
  signal: AbortSignal
}) => Promise<{ paused?: { callId: CallId; reason: string } }>

export function createSettlePending(deps: { log: EventLogPort; dispatch: Dispatch }): SettlePending {
  return async ({ branchId, signal }) => {
    const events = await deps.log.read({ branchId })
    const calls = [...pendingCalls(events)].sort((left, right) => left.ordinal - right.ordinal)

    for (const call of calls) {
      if (signal.aborted) return {}

      const drafts = await deps.dispatch({ call, signal })
      if (drafts.length > 0) await deps.log.append({ branchId, runId: call.runId, drafts })

      const asked = drafts.find((draft) => draft.type === 'approval-requested')
      if (asked !== undefined) return { paused: { callId: asked.callId, reason: asked.reason } }
    }

    return {}
  }
}
