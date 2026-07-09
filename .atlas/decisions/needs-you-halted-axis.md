---
id: needs-you-halted-axis
title: "Turn-stopping errors surface via a persisted `halted` flag, not by mutating job.status"
status: proposed
tags: ["needs-you", "jobs-schema", "realtime", "error-visibility"]
decided_on: 2026-07-08
authored_by: atlas
confirmed_by_operator: false
source_job: "6d96823d-c0aa-48e5-ac95-5a7e9851f6fa"
source_decision: "d1"
supersedes: []
superseded_by: null
governs_paths: ["backend/src/app/domain/job.ts", "backend/src/app/persistence/entities/job.entity.ts", "backend/src/app/realtime/job-realtime.model.ts", "backend/src/app/brain/agent-session-manager.service.ts"]
last_reconciled: 2026-07-08T20:47:06.339Z
---
# Turn-stopping errors surface via a persisted `halted` flag, not by mutating job.status

## Context

The sidebar/needs-you signal is derived by the single pure function `deriveNeedsYou` over denormalized columns on the `jobs` row (`status`, `turn_active`, `open_question_count`, and now `halted`), consumed identically by the REST list mappers and the WAL realtime mapper. Chat-turn (brain) failures deliberately never touch `job.status` (status carries pipeline stage and the resume path relies on it), which historically left a stopped thread rendering as alive.

## Decision

A stop-the-world turn failure is represented by an orthogonal, persisted boolean `halted` column on the `jobs` table (physical table `jobs`, renamed from `threads`). It is SET at the single `saySystemOperator` choke-point (all turn-failure branches) and CLEARED at `runChatTurn` start (covering both a new operator message and the Resume button). It is folded into `deriveNeedsYou` as a gate that returns true, and rendered as the `failed`-style ✕ glyph in the sidebar regardless of `status`. Unlike `turn_active`, `halted` is NOT reset on boot — an unresolved error must survive a restart. `job.status` is never mutated by a chat-turn error.

## Consequences

Future needs-you inputs should follow the same pattern: a denormalized column on `jobs` folded into `deriveNeedsYou` (kept single-sourced across all call sites), not a per-message join. Any new turn-outcome state that should draw operator attention should reuse/extend `halted` rather than inventing a new `status` value.

## Alternatives considered

Flipping `job.status` to `failed` on chat-turn errors (rejected — loses pipeline stage, breaks resume). Deriving 'unresolved error box' from the latest message (rejected — the realtime mapper is a flat projection of `jobs` with no join seam).
