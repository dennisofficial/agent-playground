---
id: github-pr-state-sync-silent-not-brain-pipeline
title: "GitHub pull_request state syncs silently to DB columns, never through the job/brain pipeline"
status: proposed
tags: ["github", "webhooks", "sync", "pr-state"]
decided_on: 2026-07-09
authored_by: atlas
confirmed_by_operator: true
source_job: "e4157897-a980-477b-b0e1-31e023cd60e5"
source_decision: "d3"
supersedes: []
superseded_by: null
governs_paths: []
last_reconciled: 2026-07-09T01:08:56.332Z
---
# GitHub pull_request state syncs silently to DB columns, never through the job/brain pipeline

## Context

GitHub sends two fundamentally different kinds of event to Atlas: (a) events that need action — CI failures, PR reviews/comments — which should route to the owning job's brain (or seed a new job), and (b) pure state facts — a PR opened/merged/closed/reopened — which are not tasks. Before this, pull_request events were unhandled and PR-state (pr_state, merge/close teardown) was only ever detected by the 30-min poll; the intake pipeline (StimulusIntake.intakeEvent) only wakes/creates jobs and never writes sync columns.

## Decision

GitHub `pull_request` events are handled as a SILENT state sync that writes the owning job's DB columns directly (pr_state; pr_url/pr_number/status:'done' on opened; sandbox teardown on merged/closed; pr_state back to 'open' on reopened) and NEVER goes through StimulusIntake — a PR-state fact must not wake a brain or seed a job. The apply-state logic is a single shared method (JobLifecycleService.applyGithubPrState) called by BOTH the webhook fast path and the 30-min poll so they cannot drift. pr_state and status are separate axes: a merge flips pr_state only (status already latched 'done' when the PR opened).

## Consequences

Any future GitHub-event work must preserve the split: state facts → silent column sync; actionable events → intake/brain. The poll remains the authoritative backstop and must apply the same shared method. UI badges read jobs.pr_state via WAL realtime, so keeping that column fresh is the whole game.

## Alternatives considered

Route pull_request through the existing intake pipeline (rejected — it would wake the brain / create jobs for pure state facts). Add a bespoke second poller (rejected — drift risk; one shared apply-method instead).
