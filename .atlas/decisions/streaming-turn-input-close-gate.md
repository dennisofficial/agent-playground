---
id: streaming-turn-input-close-gate
title: "Streaming turns close their input/control channel only on a genuinely-completed result"
status: proposed
tags: []
decided_on: 2026-07-08
authored_by: atlas
confirmed_by_operator: false
source_job: "14bbb8ae-8ead-4dce-97f8-b7749a39f837"
source_decision: "d1"
supersedes: []
superseded_by: null
governs_paths: ["backend/src/app/engine/engine-core.ts"]
last_reconciled: 2026-07-08T21:55:29.298Z
---
# Streaming turns close their input/control channel only on a genuinely-completed result

## Context

EngineCore drives steerable turns (the operator brain and any streaming-input turn) by feeding the Claude Agent SDK a manual input stream; the turn ends only when the engine closes that input. Host-bridge tools are invoked over the CLI control channel that rides the SAME input stream, so closing input while the turn is still active orphans any in-flight or subsequent host-tool call and the CLI throws a bare 'Stream closed'. The SDK emits a success `result` not only on true completion but also mid-turn when it PAUSES (rate-limit / retry / budget interrupt, background/deferred), and with long inter-message gaps a fixed post-result grace timer can fire the close under a still-active turn (prod incident b30616d2).

## Decision

Arm the end-of-turn input close (scheduleEnd → input.end) ONLY when the SDK success result signals the model genuinely ended its turn: `terminal_reason === 'completed'`, or (CLI-drift fallback) `terminal_reason` absent AND `stop_reason === 'end_turn'`. Any other success result keeps input OPEN (cancel any pending close), because the CLI paused and will resume and may still call host tools.

## Consequences

Streaming turns never tear down their input/control channel while the model may still act, eliminating the mid-turn 'Stream closed' host-tool failure. Turns close on strictly fewer results than before (only true completions), so behavior is safer, never more eager. A turn stuck retrying forever will not auto-close; that is bounded by the existing finally-block close on abort/error and by operator Stop (both unchanged). Verified live against claude-agent-sdk 0.3.201: a completed turn — even one calling an alwaysLoad host tool mid-turn — carries terminal_reason 'completed' + stop_reason 'end_turn' and closes cleanly.

## Alternatives considered

(a) Close on EVERY success result — the original behavior and the bug. (b) Key the gate on terminal_reason 'tool_deferred' / deferred_tool_use — rejected: host-bridge tools are created alwaysLoad and auto-approved, so they are never deferred behind tool search. (c) Lengthen the fixed grace — rejected: races arbitrarily long pauses (the incident had 70s gaps under heavy throttling).
