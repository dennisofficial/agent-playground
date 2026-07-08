---
id: ship-gate-driver-builds-only
title: "The ship-review gate and driver ship path apply to DRIVER builds only, never brain-owned direct builds"
status: proposed
tags: ["driver", "ship-gate", "hilt", "direct-build"]
decided_on: 2026-07-08
authored_by: atlas
confirmed_by_operator: true
source_job: "46d6f99c-20c0-4806-9200-e9ea40eb44b4"
source_decision: "d1"
supersedes: []
superseded_by: null
governs_paths: ["backend/src/app/driver/thread-driver.service.ts"]
last_reconciled: 2026-07-08T20:49:25.818Z
---
# The ship-review gate and driver ship path apply to DRIVER builds only, never brain-owned direct builds

## Context

Two ship paths exist. DRIVER builds (full-path plans) build via ThreadDriver and must PARK for the operator's 'Ship it' before opening a PR. DIRECT builds (fast path) are brain-owned: on approval the brain implements via runDirectBuild and opens its own PR via the finalize_build tool — the operator already consented to the PR on the start_direct_build card, so there is no second gate. A direct build persists ONLY a render-only `main` thread (zero builder/master_review), while a driver build always has >=1 builder + a master_review.

## Decision

ThreadDriver.runJob early-returns when a job has NO driver-executable (builder/master_review) threads. Such a job is brain-owned (a direct build, or an unplanned/render-only job) and the driver must neither build, gate, nor ship it. This is the single choke point covering every drive() entry (boot resume(), retry, resumePaused, reconcile). shipGateApplies() intentionally keys only on kind (feature/bugfix); the driver-vs-brain distinction is 'does the job have executable threads', enforced by this guard.

## Consequences

A reconciler re-driving a still-running direct build can no longer fall through the empty thread loop to the ship gate (which wrongly parked it at awaiting_ship_review and posted a spurious 'Ship it' card) or re-ship it. Any future job type dispatched through the driver MUST carry >=1 executable thread or the driver will silently yield on it.

## Alternatives considered

Excluding direct builds inside shipGateApplies() alone — rejected: it stops the bogus card but still lets runJob fall through to finalizeBuild and redundantly re-ship the direct build (extra promote turn + PR edit). The runJob guard fixes both.
