---
id: github-two-webhook-endpoints
title: "Two GitHub webhook endpoints by concern: /ingress/github (events→jobs) vs /webhooks/github (silent PR-state)"
status: proposed
tags: ["github", "webhooks", "ingress", "api-contract"]
decided_on: 2026-07-09
authored_by: atlas
confirmed_by_operator: true
source_job: "e4157897-a980-477b-b0e1-31e023cd60e5"
source_decision: "d5"
supersedes: []
superseded_by: null
governs_paths: []
last_reconciled: 2026-07-09T01:08:56.332Z
---
# Two GitHub webhook endpoints by concern: /ingress/github (events→jobs) vs /webhooks/github (silent PR-state)

## Context

GitHub routes deliveries by hook URL. Atlas has two distinct concerns for GitHub webhooks: turning events into work (job creation / routing failures & reviews to the owning brain) versus silently syncing PR state. Bundling both onto the job-intake controller muddied its charter.

## Decision

GitHub webhooks are split across two endpoints/controllers sharing only HMAC-verify + repo-routing: /ingress/github keeps its charter (workflow_run/check_run/check_suite/pull_request_review/review+issue comments → route to owning job by PR#/branch correlation, else seed a new job) and does NOT process pull_request; /webhooks/github is self-contained and handles ONLY pull_request → the silent GithubPrStateSync, never touching StimulusIntake. Registration provisions two per-repo hooks accordingly (WORK_EVENTS→/ingress/github, STATE_EVENTS=[pull_request]→/webhooks/github).

## Consequences

New GitHub event types are added to whichever endpoint matches their concern (actionable → ingress; state fact → webhooks). Two hooks per repo appear in GitHub's settings. /ingress/github must never regain pull_request handling.

## Alternatives considered

One shared controller/adapter classifying all events (rejected — leaks state-sync into the job-intake charter and produced two identical clone controllers). A single hook URL dispatching internally (rejected — inverts ingress into a downstream of a webhooks front door).
