// PROTOTYPE — throwaway. The invented data the round-2 surfaces have no producer for yet.

import { ESidebarTaskState, IDLE_SIDEBAR, type SidebarModel } from '../src/store'
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
  git: { branch: 'auth/rotation' },
  pr: { number: 412, state: 'draft' },
  ci: { running: 2, passed: 3, failed: 1 },
  todo: [
    { id: 'k1', label: 'Revocation store on jti', state: ESidebarTaskState.Done },
    { id: 'k2', label: 'Issue and rotate a pair', state: ESidebarTaskState.Done },
    { id: 'k3', label: 'Cover rotation and reuse', state: ESidebarTaskState.Running },
    { id: 'k4', label: 'Reject a revoked jti', state: ESidebarTaskState.Pending },
    { id: 'k5', label: 'Drop the old column', state: ESidebarTaskState.Pending },
  ],
  subagents: [
    { id: 's1', name: 'test-writer', calls: 41, awaitingApproval: false },
    { id: 's2', name: 'migration', calls: 3, awaitingApproval: true },
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
