---
id: tool-bridge-reply-liveness
title: "Tool-bridge reply delivery is durable + liveness-driven, never wall-clock-bounded"
status: proposed
tags: []
decided_on: 2026-07-08
authored_by: atlas
confirmed_by_operator: true
source_job: "923bff1a-202d-4df8-9ceb-60363819ea1e"
source_decision: "d1"
supersedes: []
superseded_by: null
governs_paths: ["backend/src/app/sandbox/image/engine-entrypoint.ts", "backend/src/app/sandbox/image/mcp-bridge-server.ts", "backend/src/app/sandbox/image/tool-bridge-reader.ts", "backend/src/app/sandbox/redis-engine-runner.ts", "backend/src/app/engine/tool-bridge-host.ts", "backend/src/app/engine/engine.types.ts"]
last_reconciled: 2026-07-08T21:56:19.773Z
---
# Tool-bridge reply delivery is durable + liveness-driven, never wall-clock-bounded

## Context

Host tool calls proxy over Redis: the in-container engine XADDs a tool_request to turn:{T}:tools and awaits a reply on turn:{T}:replies. A synchronous call (e.g. review_plan) can take many minutes. A silently-dying in-container replies-reader once left such a call hung ~1.5h even though the host wrote the reply on time.

## Decision

Reply delivery must never hang a call forever and must NEVER impose a wall-clock ceiling on call duration — legitimate long calls (subagents, reviews, builds) run freely. Correctness rests on THREE invariants: (1) the replies-reader loop can never be terminated by a transient xread throw or a malformed frame (guard inside the loop; the outer catch logs, never silently swallows); (2) the reader is self-healing — it stamps a liveness tick each XREAD cycle and a watchdog force-resets the Redis connection and resumes from the last stream id when the loop stops ticking, so a reply queued during a transport outage is still delivered (turn streams are durable for the life of the turn); (3) failure is detected by LIVENESS, not elapsed time — the host emits in-flight heartbeat frames (tool_progress) while a handler is awaited, and the client rejects a call only when heartbeats GAP out. Both bridges (Claude engine-entrypoint, Codex mcp-bridge-server) share ONE reader implementation.

## Consequences

Any future change to the tool-bridge transport must preserve these invariants: no timeout that caps call duration; keep the reader crash-proof and self-healing; keep the host heartbeat + client gap-detection as the liveness signal. New wire frames on turn:{T}:replies must be non-terminal-safe (unknown/liveness frames must not resolve or reject a pending call). The two bridges must not diverge — fix the shared reader once.

## Alternatives considered

A wall-clock reply timeout was rejected: any fixed ceiling either aborts legitimate long calls or is too long to help. A client-only fix (reader hardening alone) was insufficient because it cannot detect a host-side hang / host-process death mid-call.
