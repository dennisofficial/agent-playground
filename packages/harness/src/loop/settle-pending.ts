import {
  isConcurrencySafeCall,
  partitionToolCalls,
  pendingCalls,
  rowsOwnedBy,
  sessionDirectoryOf,
  type ThreadId,
  type CallId,
  type EventLogPort,
  type ToolDeclaration,
} from '@dltech/atlas-core'

import type { DispatchableCall, ToolDispatcher } from '../tools/dispatch'

export type SettlePending = (args: {
  threadId: ThreadId
  signal: AbortSignal
}) => Promise<{ paused?: { callId: CallId; reason: string } }>

export function createSettlePending(deps: {
  log: EventLogPort
  dispatch: ToolDispatcher
  tools?: readonly ToolDeclaration[] | undefined
  projectDirectory?: string | undefined
}): SettlePending {
  const declarations = new Map((deps.tools ?? []).map((tool) => [tool.name, tool]))

  const isSafe = (call: DispatchableCall): boolean =>
    isConcurrencySafeCall({ declaration: declarations.get(call.name), input: call.input })

  return async ({ threadId, signal }) => {
    const events = await deps.log.read({ threadId })
    const calls = [...pendingCalls(rowsOwnedBy({ events, threadId }))].sort(
      (left, right) => left.ordinal - right.ordinal,
    )

    const runs = partitionToolCalls({ calls, isSafe })

    let sessionDirectory = sessionDirectoryOf({
      events,
      projectDirectory: deps.projectDirectory ?? process.cwd(),
    })

    for (const run of runs) {
      if (signal.aborted) return {}

      const settled = await Promise.all(
        run.map((call) => deps.dispatch.dispatch({ call, signal, sessionDirectory })),
      )

      for (const [index, drafts] of settled.entries()) {
        const call = run[index]
        if (call === undefined || drafts.length === 0) continue
        await deps.log.append({ threadId, runId: call.runId, drafts })
      }

      const moved = settled.flat().findLast((draft) => draft.type === 'cwd-changed')
      if (moved !== undefined) sessionDirectory = moved.path

      const asked = settled.flat().find((draft) => draft.type === 'approval-requested')
      if (asked !== undefined) return { paused: { callId: asked.callId, reason: asked.reason } }
    }

    return {}
  }
}
