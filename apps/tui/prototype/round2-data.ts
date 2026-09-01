// PROTOTYPE — throwaway. The invented data the round-2 surfaces have no producer for yet.

import { EAgentStatus } from '@dltech/atlas-core'

import {
  ESidebarTaskState,
  ESpendReading,
  IDLE_SIDEBAR,
  SPEND_UNAVAILABLE,
  type SidebarModel,
} from '../src/store'
import type { Hint } from '../src/ui/hint-layout'

export const HINTS: readonly Hint[] = [
  { key: '⇥', label: 'next page' },
  { key: 'ctrl+c', label: 'quit' },
]

export const FED_SIDEBAR: SidebarModel = {
  ...IDLE_SIDEBAR,
  title: 'Refresh-token rotation',
  turnCount: 14,
  totalTokens: 22_400,
  todo: [
    { id: 'k1', label: 'Revocation store on jti', state: ESidebarTaskState.Done },
    { id: 'k2', label: 'Issue and rotate a pair', state: ESidebarTaskState.Done },
    { id: 'k3', label: 'Cover rotation and reuse', state: ESidebarTaskState.Running },
    { id: 'k4', label: 'Reject a revoked jti', state: ESidebarTaskState.Pending },
    { id: 'k5', label: 'Drop the old column', state: ESidebarTaskState.Pending },
  ],
  subagents: [
    {
      id: 's1',
      name: 'test-writer',
      status: EAgentStatus.Running,
      calls: 41,
      lastTool: 'edit',
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: null,
      state: 'edit · 1m 4s',
      spend: {
        reading: ESpendReading.Counted,
        totals: {
          turns: 6,
          steps: 12,
          inputTokens: 48_200,
          outputTokens: 3_100,
          cacheReadTokens: 41_000,
          cacheWriteTokens: 2_000,
        },
      },
      selected: false,
    },
    {
      id: 's2',
      name: 'migration',
      status: EAgentStatus.Blocked,
      calls: 3,
      lastTool: 'bash',
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: null,
      state: 'blocked · 12s',
      spend: SPEND_UNAVAILABLE,
      selected: false,
    },
  ],
  teammates: [
    { id: 't1', name: 'dana', activity: 'reviewing #412' },
    { id: 't2', name: 'omar', activity: null },
  ],
}

export const PATCH = `diff --git a/src/auth/auth.service.ts b/src/auth/auth.service.ts
--- a/src/auth/auth.service.ts
+++ b/src/auth/auth.service.ts
@@ -118,7 +118,12 @@ AuthService.validateUser
   async validateUser(email: string) {
-    const user = await this.users.byEmail(email)
+    const user = await this.users.byEmail(email, { withSecret: true })
+    if (!user) throw new UnauthorizedException()
   }
 
 
 
 
 
 
 
+  async rotate(token: string) {
+    const claim = await this.jwt.verifyAsync(token, REFRESH_OPTS)
+    await this.revoked.add(claim.jti, claim.exp)
+    return this.issue(claim.sub)
+  }
`
