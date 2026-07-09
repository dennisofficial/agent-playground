---
id: job-halt-lifecycle-invariant
title: "A halted job is never auto-driven; halt clears only on budget-aware recovery"
status: proposed
tags: []
decided_on: 2026-07-09
authored_by: atlas
confirmed_by_operator: false
source_job: "c9951e7f-60d5-43e3-921a-6fc892a40f65"
source_decision: "d5"
supersedes: []
superseded_by: null
governs_paths: ["backend/src/app/driver/thread-driver.service.ts", "backend/src/app/driver/driver-store.service.ts", "backend/src/app/brain/agent-session-manager.service.ts"]
last_reconciled: 2026-07-09T03:02:39.770Z
---
# A halted job is never auto-driven; halt clears only on budget-aware recovery

## Context

Because a halted job now keeps `status='running'` (see job-status-phase-vs-halt), the generic drive/boot/dispatch paths that key off `status==='running'` would otherwise auto-re-drive it, bypassing the bounded halt-fix retry budget.

## Decision

Invariant: `job.halt != null` ⇒ the job is NOT driven. The halt is cleared ONLY by the three explicit, budget-aware recovery entry points: `ThreadDriver.retry()`, `resumePaused()`, and `redriveThread()` (all re-arm/respect the halt-fix budget). Enforcement points: `runningJobs()` filters `halt IS NULL` (boot worklist); `runJob()` refuses when `halt != null` (the single drive chokepoint); `dispatch()` and the brain `dispatch_build` tool refuse halted jobs; a fresh plan-approval clears the halt at the approval transition, not inside `dispatch()`.

## Consequences

Any NEW drive/dispatch entry point must respect the invariant (refuse when halted; only the budgeted recovery paths clear the halt). Retry/resume are the sanctioned resume routes; `/retry` and the workspace HALTED/Re-ping banner drive them and gate on `!halt`.

## Alternatives considered

Clear the halt inside `dispatch()` (rejected: `dispatch_build` reaches it gated only on `status==='running'`, which halted jobs satisfy — an un-budgeted bypass of the halt-fix budget).
