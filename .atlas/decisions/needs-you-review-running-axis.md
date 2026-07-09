---
id: needs-you-review-running-axis
title: "A running Codex review suppresses the needs-you dot via a denormalized jobs.review_running flag"
status: proposed
tags: ["needs-you", "realtime", "plan-review", "data-model"]
decided_on: 2026-07-09
authored_by: atlas
confirmed_by_operator: true
source_job: "10a55c71-6d12-46b2-be20-3838d4612100"
source_decision: "d1"
supersedes: []
superseded_by: null
governs_paths: ["backend/src/app/domain/job.ts", "backend/src/app/realtime/job-realtime.model.ts", "backend/src/app/surface/web-surface.controller.ts", "backend/src/app/brain/plan-review.service.ts"]
last_reconciled: 2026-07-09T12:09:31.785Z
---
# A running Codex review suppresses the needs-you dot via a denormalized jobs.review_running flag

## Context

`deriveNeedsYou` (backend/src/app/domain/job.ts) is the single server-owned definition of the sidebar alert dot, consumed by BOTH the REST thread-list shape and the single-table WAL realtime mapper (they must never diverge). During a synchronous `review_plan`, a job's `status` stays `planning` and the parent turn's `turn_active` can be cleared by the liveness watchdog while the Codex review is still genuinely running, which false-lit the dot. The realtime mapper can only see the `jobs` row, so it cannot query `codex_reviews`.

## Decision

The set of needs-you axes is {status, turn_active, open_question_count>0, halted, review_running}. `review_running` is a denormalized boolean on `jobs`, kept in sync with the job's `codex_reviews` row (true iff status='running') solely by `PlanReviewService.persistRow`. In `deriveNeedsYou` it is checked AFTER deleting/awaitingQuestion/halted/turnActive and suppresses the dot in the terminal fallback only — a live review is owned by the system, not the operator.

## Consequences

Any change to how needs-you / job conditions are derived must preserve (or explicitly supersede) the review_running axis, keep REST and realtime mappers in agreement, and keep persistRow as the sole writer of jobs.review_running. A genuinely dead review still surfaces because it resolves to failed/complete or sets `halted` (checked first).

## Alternatives considered

Batch-querying codex_reviews in the REST controllers only (rejected: cannot reach the live SSE sidebar, which is the reported symptom). Reviving the vestigial `plan_review` status (rejected: collides with the pending statuses/conditions rework).
