---
id: operator-facing-ids-sequential-scheme
title: "Operator-referenced ids use short sequential per-job schemes (d#, q#)"
status: proposed
tags: ["conventions", "brain", "ids"]
decided_on: 2026-07-08
authored_by: atlas
confirmed_by_operator: true
source_job: "f04ee23c-b5db-4fdf-b7e8-6bb0742b4a3b"
source_decision: "d1"
supersedes: []
superseded_by: null
governs_paths: ["backend/src/app/surface/web-question-card.ts", "backend/src/app/domain/decision-record.ts", "backend/src/app/brain/brain-store.service.ts"]
last_reconciled: 2026-07-08T21:21:24.537Z
---
# Operator-referenced ids use short sequential per-job schemes (d#, q#)

## Context

Ids the operator sees and the brain must type back into tools (decision ids in update/delete_decision; question ids in withdraw_question / create_decision({questionId})) were opaque uuids for questions (q-<uuid>). A full uuid is painful to reference by hand in chat and in tool args.

## Decision

Per-job identifiers that a human or the brain references by hand use a short, human-typable sequential scheme, allocated max-based over existing ids so a deleted/withdrawn id is never reused: decisions are d1, d2, … (nextDecisionId in backend/src/app/domain/decision-record.ts) and the conversational brain's ask_question ids are q1, q2, … (nextQuestionId in backend/src/app/surface/web-question-card.ts, via BrainStoreService.nextQuestionId). The card key remains the per-message `ts` value, so there is no DB migration and pre-existing uuid ids stay valid.

## Consequences

New human-referenced id types should follow the same short-sequential, max-based, no-reuse pattern rather than minting uuids. The driver's build-origin request_operator_input cards are exempt (driver-polled, never typed by Atlas) and keep uuids.

## Alternatives considered

Keep q-<uuid> for questions — rejected as too hard to reference by hand.
