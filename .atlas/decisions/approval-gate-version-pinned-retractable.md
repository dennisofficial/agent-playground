---
id: approval-gate-version-pinned-retractable
title: "Plan approval is version-pinned and retractable — approve only the current draft of an awaiting_approval job"
status: proposed
tags: []
decided_on: 2026-07-09
authored_by: atlas
confirmed_by_operator: true
source_job: "b30616d2-4e78-467d-b949-baab23d7d835"
source_decision: "d1"
supersedes: []
superseded_by: null
governs_paths: ["backend/src/app/brain/brain-store.service.ts", "backend/src/app/brain/agent-session-manager.service.ts", "backend/src/app/brain/decision-approval.service.ts", "backend/src/app/surface/web-surface.module.ts"]
last_reconciled: 2026-07-09T10:42:58.436Z
---
# Plan approval is version-pinned and retractable — approve only the current draft of an awaiting_approval job

## Context

The operator-facing plan-approval gate was derived purely from jobs.status='awaiting_approval' and resolved by jobId alone — it approved 'whatever decision record is currently attached', with no binding to the plan version the operator clicked and no self-service way for Atlas to retract a proposal it kept revising. A pending approval could therefore dispatch a stale / work-in-progress plan (e.g. after continued grilling or a pivot to a bigger plan).

## Decision

The approval control path enforces ONE invariant: a plan may be approved only while it is still the CURRENT DRAFT of an awaiting_approval job. Realized by three coordinated mechanisms. (1) store.approve is a single atomic guarded UPDATE keyed on jobs.status='awaiting_approval' AND jobs.decision_record_id=<the decisionRecordId the operator actually clicked>; that clicked record id is threaded through BOTH resolve paths (live DecisionApprovalService.resolve and the restart-safe resolveApprovalDurably) via ApprovalResolution.clickedDecisionRecordId. (2) A withdraw_plan host tool atomically flips awaiting_approval->planning (guarded), supersedes the draft decision record, and cancels the live approval handle. (3) propose_plan / start_direct_build cleanly supersede a pending proposal via a shared withdraw-then-propose helper (atomic: retract-then-persist), and REFUSE rather than clobber a job already past the gate (running/awaiting_ship_review/done/etc.).

## Consequences

A withdrawn, superseded, version-mismatched, or already-approved click approves nothing — the guarded UPDATE matches 0 rows and the operator gets a 'that plan was withdrawn or updated — nothing was approved' note instead of a silent wrong-plan dispatch. Exactly one of {withdraw, approve, re-propose} wins any race, arbitrated by the guarded UPDATEs (all conditioned on status='awaiting_approval'). Any future change to the approval/dispatch path MUST preserve this guarded arbitration and the clicked-version pin; brain-side/UI code must keep passing the clicked decisionRecordId through to store.approve.

## Alternatives considered

Auto-invalidate the pending approval on any continued spec edit / review activity after proposing (rejected: fragile in the fire-and-forget model where Atlas keeps talking in the same turn the card posts). A bare retract tool WITHOUT the guarded approve + clean re-propose (rejected: leaves the approve-click race and the propose_plan no-op / start_direct_build leaky-overwrite traps intact).
