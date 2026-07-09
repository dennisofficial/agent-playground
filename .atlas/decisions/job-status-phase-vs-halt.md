---
id: job-status-phase-vs-halt
title: "Job status is the pure build phase; failure/halt is a separate `halt` field"
status: proposed
tags: []
decided_on: 2026-07-09
authored_by: atlas
confirmed_by_operator: true
source_job: "c9951e7f-60d5-43e3-921a-6fc892a40f65"
source_decision: "d4"
supersedes: []
superseded_by: null
governs_paths: ["shared/src/types/job-status.ts", "backend/src/app/domain/job.ts", "backend/src/app/persistence/entities/job.entity.ts", "backend/src/app/surface/web-surface.controller.ts", "web/src/lib/api/**"]
last_reconciled: 2026-07-09T03:02:39.770Z
---
# Job status is the pure build phase; failure/halt is a separate `halt` field

## Context

The `jobs` row's `status` historically mixed lifecycle PHASES (planning/running/awaiting_*) with terminal OUTCOMES (failed/paused), so a failure overwrote and discarded the phase the job was in. The build lanes (`threads`) already modeled outcome separately (terminal_record/halt_outcome). NOTE: distinct from the separate `halted` boolean main added for chat-turn failures — this is the structured build halt.

## Decision

`JobStatus` is the pure build PHASE only: `open | planning | plan_review | awaiting_approval | running | awaiting_ship_review | done | cancelled | deleting`. `failed` and `paused` are NOT status values — removed from the enum. Failure/halt lives in a new nullable structured job-level field `halt: { kind: 'failed'|'blocked_credentials'|'budget_exhausted'|'incomplete'; reason; at } | null`, orthogonal to phase: a halted job KEEPS its phase (e.g. stays `running`) and carries the halt. `cancelled` stays a genuine terminal phase. This is the wire contract in `@workspace/shared` consumed by backend and web; `/web/jobs`, realtime rows, and the pipeline-detail projection all emit `status`(phase) + `halt`. `deriveNeedsYou` takes a `halted` axis (build halt OR chat-turn failure ⇒ needs-you).

## Consequences

Any code asking 'did the job fail/pause?' must read `job.halt`, NEVER `status === 'failed'|'paused'` (those are gone — a compile error now). New halt kinds extend the `JobHaltKind` union. UI renders halt as an overlay/banner on top of the phase, not as a status. Legacy rows were backfilled (failed→done+halt.kind=failed, paused→running+halt.kind=blocked_credentials).

## Alternatives considered

Keep `failed` as a terminal status (rejected: loses which phase failed, and forces a separate 'Failed' bucket instead of showing the job under the phase it died in).
