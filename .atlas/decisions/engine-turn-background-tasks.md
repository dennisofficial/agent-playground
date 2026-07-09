---
id: engine-turn-background-tasks
title: "Engine turns stay alive for in-flight SDK background tasks, bounded by a hold cap"
status: proposed
tags: ["engine", "turn-lifecycle", "claude-agent-sdk", "background-tasks", "atlas-svc"]
decided_on: 2026-07-09
authored_by: atlas
confirmed_by_operator: true
source_job: "c009ceee-f941-42c5-97ef-c105b6e7144c"
source_decision: "d1"
supersedes: []
superseded_by: null
governs_paths: ["backend/src/app/engine/**"]
last_reconciled: 2026-07-09T01:57:41.998Z
---
# Engine turns stay alive for in-flight SDK background tasks, bounded by a hold cap

## Context

A brain turn is one streaming `claudeSdk.query()` that Atlas closes shortly after the model's message (STEER_IDLE_GRACE_MS) and then force-exits the in-container process. The Claude Agent SDK runs a tool-native `run_in_background` Bash task as a detached child of that same process, delivering its completion as an in-session `task_notification` plus a model auto-continuation. Closing the turn at the first result therefore kills the task before it finishes — the turn is the unit of a single docker exec, not a persistent process across turns.

## Decision

The engine MUST keep a streaming turn's query() session open while any background task is in flight, so the task's completion and the model's auto-continuation are delivered IN-TURN (same exec, no cross-turn carry-over). It tracks a live background-task set from the SDK system messages `task_started` (add task_id) / `task_notification` (remove task_id) and gates the input-close on that set being empty — NOT on the result message, because for run_in_background the first result is terminal_reason='completed' with background_tasks=undefined. The hold is bounded by a configurable ceiling (BG_TASK_MAX_HOLD_MS, ~10 min default); at the cap the engine injects an in-turn notice and force-closes, killing the outstanding task. Long-running processes (dev servers, watchers) are NOT a run_in_background use case — they belong under atlas-svc, and the cap notice steers agents there.

## Consequences

Background tasks that finish within the cap now complete and wake the agent in the same turn. Host-side liveness (isBusy/turn_active/heartbeat) already covers the longer turn, so no watchdog/idle-reap change is needed. Any future change to turn finalization (the input-close, the 350ms grace, the entrypoint process.exit) must preserve the in-flight-background-task hold and its cap, or it reintroduces the silent-kill bug. Usage must be aggregated across the extra result(s) a held turn produces.

## Alternatives considered

Cross-turn resumption (carry a completed task's result into a fresh next turn) — rejected as unnecessary machinery; it all fits in one exec. Gating on the result message's terminal_reason/background_tasks — rejected: not populated for tool-native run_in_background (spike-verified against SDK 0.3.201). No cap (hold until the task exits) — rejected: a never-terminating backgrounded process would wedge the turn and hold the container busy indefinitely.
