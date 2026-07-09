---
id: jobs-build-path-marker
title: "jobs.build_path is the durable marker of committed build path (direct vs plan)"
status: proposed
tags: ["data-model", "pipeline", "ui"]
decided_on: 2026-07-09
authored_by: atlas
confirmed_by_operator: true
source_job: "e297c74c-6681-4141-b43d-931b0212b270"
source_decision: "d1"
supersedes: []
superseded_by: null
governs_paths: ["backend/src/app/persistence/entities/job.entity.ts", "backend/src/app/brain/brain-store.service.ts", "backend/src/app/driver/driver-store.service.ts", "web/src/features/job-workspace/navigator.tsx"]
last_reconciled: 2026-07-09T12:12:46.408Z
---
# jobs.build_path is the durable marker of committed build path (direct vs plan)

## Context

Nothing on the pipeline DTO distinguished a committed direct build (fast, brain-implemented) from a plan/driver build. The UI was tempted to infer it from message history or the fragile 'status running + empty threads' invariant, both of which drift as build mechanics change.

## Decision

Persist the build path explicitly on `jobs.build_path` ('direct' | 'plan' | null). It is stamped ATOMICALLY with the awaiting_approval→running flip in BrainStoreService.approve() — the single approval choke point (its caller actOnApprovalVerdict already knows isDirect). It stays null until an approval commits the path, so a proposal still at awaiting_approval (which can still be re-proposed as the other path) has no committed path. Surfaced on the pipeline DTO as PipelineJob.buildPath and consumed by the navigator to hide plan-oriented empty-state placeholders (build lanes, plan.md, generated docs) for direct builds.

## Consequences

Any consumer needing to know a job's build path should read jobs.build_path / PipelineJob.buildPath rather than re-deriving it. New approval commit paths MUST stamp build_path. Historical direct builds were backfilled from direct_build_verification IS NOT NULL.

## Alternatives considered

(1) UI inference from the last non-ship approval_card kind — rejected as fragile client-side history inference. (2) Structural 'running + empty threads' heuristic — rejected: an implicit invariant a future lane-creation change could silently break. (3) Reuse direct_build_verification — rejected: only written at finalize_build, so absent for a running direct build.
