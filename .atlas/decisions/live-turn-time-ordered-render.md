---
id: live-turn-time-ordered-render
title: "Live turn renders as one time-ordered stream; live blocks carry server emittedAt"
status: proposed
tags: []
decided_on: 2026-07-08
authored_by: atlas
confirmed_by_operator: true
source_job: "6aca78d6-2496-47ca-b376-b8166b5bdeef"
source_decision: "d1"
supersedes: []
superseded_by: null
governs_paths: ["backend/src/app/surface/live-turn-store.ts", "web/src/features/job-workspace/conversation.tsx", "web/src/features/job-workspace/bubbles.tsx", "web/src/lib/api/job-stream.ts"]
last_reconciled: 2026-07-08T20:28:24.834Z
---
# Live turn renders as one time-ordered stream; live blocks carry server emittedAt

## Context

During an in-flight (streaming) turn, the assistant's blocks live only in the resumable LiveTurnStore (not yet in the durable `messages` table), while operator/system rows (steers, system_notice/system_reminder pills, question cards, seeds) ARE persisted immediately. The web historically rendered the transcript as two fixed, always-stacked sections — [all durable messages] then [the live turn] — with no time interleaving, so anything that arrived mid-turn stacked at the TOP of the turn until the turn ended and the client reconciled against /messages (created_at ASC), which is correct by construction and regression-tested.

## Decision

The live/in-flight turn is composed as a SINGLE time-ordered stream, not two stacked sections. LiveTurnStore stamps every live block with a server-authoritative `emittedAt` (epoch ms, monotonic) and carries it on the reconnect snapshot and each block-creating delta frame (the frame field is optional; turn_start/turn_end carry none). The web partitions durable rows at the turn boundary (`liveTurn.startedAt`): rows posted before the turn stay in the virtualized durable list; rows posted during the turn are time-merged with the live blocks (durable `postedAt` vs live `emittedAt`, both server time) in the trailing normal-flow section. Durable persistence and its timestamps are NOT touched — the after-turn reconciled order was already correct.

## Consequences

Any mid-turn durable row kind interleaves uniformly with no per-kind plumbing, and it self-heals across a mid-turn reconnect because both sides sort on server time. New live-stream frames/blocks MUST preserve `emittedAt` on creation (append-to-open-block keeps the block's start-time stamp). The streaming blocks must stay in normal flow (NOT virtualized) for smooth token updates; only the few durable mid-turn interlopers move into the trailing merge. Merge granularity is the tool GROUP (a steer landing between two tools of one run renders adjacent to the group, not splitting it — exact on reconcile).

## Alternatives considered

Rejected a backend inline-frame-per-kind approach (emit a synthetic live frame into LiveTurnStore for each durable-row kind on delivery): fragile and ever-growing — every future row type would have to remember to emit its own live frame. The time-merge handles all kinds with one mechanism.
