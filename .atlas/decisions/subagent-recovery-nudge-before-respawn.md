---
id: subagent-recovery-nudge-before-respawn
title: "Orchestrators nudge stalled/failed subagents instead of respawning"
status: proposed
tags: ["engine", "subagents", "orchestration", "prompt-kit"]
decided_on: 2026-07-08
authored_by: atlas
confirmed_by_operator: true
source_job: "4898f61a-9bc4-4d55-beda-bf066be10af3"
source_decision: "d2"
supersedes: []
superseded_by: null
governs_paths: ["backend/src/app/engine/engine-core.ts", "backend/src/app/prompt-kit/**"]
last_reconciled: 2026-07-08T19:05:41.300Z
---
# Orchestrators nudge stalled/failed subagents instead of respawning

## Context

The engine spawns subagents via the SDK `Task` tool inside a single `query()` call. `tools:` is a RESTRICTING allowlist, and it originally exposed only `Task` (spawn) — so when a subagent stalled or hit a transient error (e.g. an API 500), the orchestrating model's only recovery was a fresh `Task`, discarding all context the failed agent had accumulated. The SDK already supports addressing a spawned agent (give it a `name`) and continuing it in place via `SendMessage`, plus `TaskOutput` (peek a background agent) and `TaskStop` (abandon a wedged one).

## Decision

Expose `SendMessage`, `TaskOutput`, and `TaskStop` to any turn that can fan out to subagents (the WORKER_TOOLS allowlist feeding the job brain's plan/execute turns and the build orchestrator), and auto-approve them so they never stall on a permission prompt. Prompt guidance instructs orchestrators to prefer nudging an existing subagent via `SendMessage` (context preserved) over respawning a fresh `Task` when one stalls or fails transiently. Do NOT grant these to review turns (no fan-out) or to subagents' own tool sets (they don't recurse).

## Consequences

A transiently-failed or stuck subagent can be recovered without losing its accumulated context. A failed nudge falls back to today's respawn, so behavior is never worse. Future engine work that changes the tool allowlists or subagent orchestration must preserve this recovery path. Open caveat: whether SendMessage can revive a fully-crashed (vs. merely stuck) agent is not proven; the respawn fallback covers that case.

## Alternatives considered

Keep respawn-only (rejected: throws away subagent context on every transient hiccup). Build host-side retry/resume machinery for subagents (rejected: unnecessary — the capability already ships in the SDK; this is config + guidance, not new machinery).
