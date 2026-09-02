import type { ThreadId } from '@dltech/atlas-core'
import { useCallback } from 'react'

import type { AtlasApp } from './compose'

export function useRevokeGrant(args: {
  app: AtlasApp
  threadId: ThreadId
  refresh: () => Promise<void>
}): (grantId: string) => void {
  const { app, threadId, refresh } = args

  return useCallback(
    (grantId: string) => {
      void (async () => {
        await app.log.append({
          threadId,
          runId: app.ids.nextRunId(),
          drafts: [{ type: 'permission-revoked', grantId }],
        })
        await refresh()
      })()
    },
    [app, refresh, threadId],
  )
}
