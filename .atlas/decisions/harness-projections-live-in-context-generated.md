---
id: harness-projections-live-in-context-generated
title: "Non-committed harness projections live in /context/generated, never the git worktree"
status: proposed
tags: []
decided_on: 2026-07-08
authored_by: atlas
confirmed_by_operator: true
source_job: "ac46eb01-d3be-4a4e-8e99-5e73db6ef497"
source_decision: "d1"
supersedes: []
superseded_by: null
governs_paths: ["backend/src/app/driver/**", "backend/src/app/brain/**", "docs/adr/**"]
last_reconciled: 2026-07-08T21:05:31.989Z
---
# Non-committed harness projections live in /context/generated, never the git worktree

## Context

The driver/brain render human-readable Markdown projections of durable DB state (terminal_record, deviations, decision records, cleared blocks) for the operator and for cross-session reads. These are NOT repo content — the DB row is the source of truth and the file is a re-render. When such a file is written into the git worktree, every build leaves untracked churn in `git status`, which invites agents to improvise `.gitignore` edits — one such edit added a blanket `.atlas/` ignore that would silence the COMMITTED `.atlas/decisions/` ledger.

## Decision

Any non-committed, host-rendered projection of DB state is written to `<contextDirHost>/generated/...` (in-sandbox `/context/generated/...`, mounted read-only), NOT into the git worktree. This is the canonical home shared by decision-record.md, deviations.md, atlas-cleared-blocks.md, and the thread halt-trail `completion.md`. The ONLY `.atlas/` path that belongs in the worktree is the COMMITTED decision ledger `.atlas/decisions/` (it rides the PR); do not conflate the two, and do not gitignore `.atlas/` broadly.

## Consequences

Halted builds leave a clean worktree (no untracked `.atlas/threads/` file); projections are surfaced in the operator UI and survive worktree teardown/rehydrate; readers must use the in-container `/context/generated/...` path. New host-written projection files should follow the `writeDeviationsMd` pattern (join contextDirHost(jobId,orgId) + 'generated').

## Alternatives considered

Keeping projections in the worktree 'files-as-store, like the decision ledger' (the original ADR 0004 framing) — rejected as a category error: the ledger is committed and rides the PR, projections are not; worktree writes cause untracked churn and are invisible to the operator UI.
