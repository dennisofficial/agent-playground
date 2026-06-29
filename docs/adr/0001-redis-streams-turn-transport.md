# ADR 0001 — Redis-Streams turn transport (durable, restart-survivable turns)

- **Status:** Accepted — implementation in progress (Phase 1a + Phase 0 pending-recovery landed; see *Status & rollout*).
- **Date:** 2026-06-29
- **Supersedes (in part):** the "one-shot `docker exec`, no daemon, no Redis" transport described in `backend/src/app/ATLAS_V2.md §6` and `docs/archived_plans/001_docker_sandbox_layer.md`.

## Context

Each engine turn runs as an **ephemeral in-container process** spawned by `docker exec atlas-engine-turn`. The engine talks to the host over the **exec stdin/stdout pipe** (`docker-engine-runner.ts`). That pipe is owned by the backend process, so a backend restart mid-turn:

- loses the in-memory `LiveTurnStore` (live turn state),
- severs SSE to the operator,
- writes post-restart engine output to a dead pipe,
- and — worst — kills the **tool-bridge stdin pipe**: if the engine is blocked waiting for a host tool reply (`submit_plan`, `ask_question`, …), the turn hangs/fails, and JSONL recovery cannot un-stick a half-executed host tool.

The engine *computation* already survives (the exec reparents to init; its SDK JSONL is on a host bind-mount). **This is a transport problem, not a compute problem.** The existing `TurnRecoveryService` (boot-time JSONL scan + back-fill) exists only because the live transport is non-durable.

There is a **second, independent axis**: the driver's job FSM self-marks builds `failed` on a graceful restart (`TrackDriver.drive()` classified every non-`EngineAuthError` as `failed`, and boot-resume only re-drives `status:'running'` jobs). Durable transport alone would not fix that.

## Decision

Move the engine↔host transport from the exec stdin/stdout pipe to **Redis Streams**, while keeping the **ephemeral per-turn process** model unchanged (preserves volume-mounted engine hot-reload — new turns always pick up new code). The backend still **kicks** each turn with `docker exec`; the exec becomes fire-and-forget because the process reads its spec from / writes events to Redis, so a backend restart neither kills nor loses the turn and any replica can re-attach to the stream.

Explicitly **no long-lived in-container daemon.** v1's fragility was exactly that — a long-lived in-container daemon over Redis RPC with version-reconcile + readiness races. This design avoids that trap: (a) no long-lived in-container process; (b) **no readiness handshake** — the host `XADD`s the spec and the durable stream decouples producer/consumer; (c) **no version-reconcile** — engine code stays volume-mounted and the stream protocol carries an explicit `v`.

Postgres stays the **authoritative record** (`messages`); Redis is a bounded, resumable **transport** with `MAXLEN`/TTL.

### Stream layout (per turn `T`)
| Key | Direction | Consumption | Purpose |
|---|---|---|---|
| `turn:{T}:spec` (key) | host → engine | one read | turn spec (replaces stdin spec) |
| `turn:{T}:events` | engine → host | `xread` tail by `lastId` | text/thinking/tool_use/tool_result/session/heartbeat/final/error — the durable live log |
| `turn:{T}:tools` | engine → host | consumer group `xreadGroup`+`ack` **+ `claimStale` pending recovery** | host-bridge `tool_request`s needing host execution |
| `turn:{T}:replies` | host → engine | `xread` tail, matched by `id` | host `tool_response`/`tool_error` |
| `turn:{T}:abort` (pub/sub) | host → engine | `subscribe` | cooperative cancel |

Frames reuse today's shapes (`{t:'event'|'tool_request'|'tool_response'|'tool_error'|'final'|'error'|'heartbeat', …}`), JSON under the single `data` field, each carrying a protocol `v`.

### Idempotent tool execution
Consumer-group delivery is at-least-once (redelivery after a crash-before-`ack`), and most of the 18 host tools have side effects (DB writes, thread/container spawns, file writes, git/PR in `finalize_build`). So:
- a durable `tool_executions(turn_id, tool_call_id) PK, result jsonb, status` dedup table;
- dispatch checks it first → cached reply + `ack` if already executed; else execute (recording the result in the same DB transaction as DB-only side effects), reply, `ack`;
- on (re)attach a fresh consumer drains the dead consumer's in-flight entries via `claimStale` (XAUTOCLAIM) instead of stranding them.

### Re-attachable registry (replaces JSONL recovery)
A durable `active_turns` row carries enough context to rebuild any turn's harness + the `buildTools` closure on re-attach: `{turn_id, thread_id, channel, lane, container_id, status, started_at, last_heartbeat_at, events_last_id, kind ∈ brain|step|review|gate|autofix, ctx jsonb}`. A leader-only `TurnWatchdogService` re-attaches running turns on boot and finalizes turns with stale heartbeats (container crash — the only truly-lost case). `TurnRecoveryService` is demoted to a JSONL fallback audit.

### Per-turn isolation
The exec pipe scoped a container to its own turn for free. With shared Redis, mint a per-turn Redis ACL user (`~turn:{T}:*`, `&turn:{T}:*`, stream+pubsub verbs only), inject its creds into the exec env, `ACL DELUSER` at turn end. The sandbox reaches Redis over a dedicated **internal** `atlas-bus` network (no internet egress).

### Driver-FSM fix (separate axis, shipped first)
A shutdown-aware catch keyed to `LeaderElectionService.isDraining()` (set at the very start of drain) leaves the job `running`/resumable instead of `failed`. It is keyed to drain state specifically, NOT to `AbortError`, so a local watchdog / `PHASE_TIMEOUT_MS` abort (which fires while still leader/follower) still stays terminal.

## Consequences

**Positive:** in-flight turns survive backend/web restarts; backends become near-stateless re: live turn state; the tool-bridge becomes replica-agnostic and crash-safe; most of `TurnRecoveryService` retires; horizontal scale becomes reachable.

**Negative / costs:** it is *not* simpler — a new transport seam, an entrypoint rewrite, ACL churn, a dedup table, and a smaller (container-crash-only) recovery path remain. Two stores of truth (Postgres authoritative, Redis transport) require a clear contract. The sandbox gains Redis network reach (mitigated by the internal-only `atlas-bus` net + per-turn ACL).

## Alternatives considered
- **Long-lived in-container daemon (the scaffolded "Phase 5" framing):** rejected — pins engine code in memory (breaks hot-reload) and recreates v1's daemon shape.
- **Redis-driven in-container launcher (backend dispatches via `XADD`, a thin launcher spawns turns):** deferred — better multi-host story but adds a long-lived (if dumb) process now; revisit when going multi-host.
- **Postgres `turn_events` + LISTEN/NOTIFY instead of Redis:** viable at small scale but poor fit for high-frequency token fanout and consumer-group at-least-once semantics; Redis Streams is purpose-built and already scaffolded in `backend/src/_lib/redis/`.

## Status & rollout
Staged so no phase claims restart-survival before its spine exists, and one-shot turns prove the transport before the bidirectional brain tool-bridge:

- **Phase 1a — driver-FSM shutdown fix.** ✅ Landed (`LeaderElectionService.isDraining()`; guarded catches in `TrackDriver` + `PlanReviewService`; unit-tested).
- **Phase 0 — foundation.** Pending-recovery `claimStale` on `RedisStreamPort` + ioredis adapter + in-memory fake ✅ landed (unit-tested). Remaining: wire `RedisModule`; `ENGINE_TRANSPORT=pipe|redis` flag; transport-aware runner factory (port the brain off the concrete `dockerRunner`); detached-exec contract; internal `atlas-bus` network; bundle `ioredis` into the engine bundle.
- **Phase 1 — durability spine** (`active_turns`, incremental block persistence, boot re-attach, rehydrate-from-stream).
- **Phase 2 — Redis transport for one-shot (non-tool-bridge) turns.**
- **Phase 3 — Redis tool-bridge for brain turns + idempotency (`tool_executions`).**
- **Phase 4 — watchdog + heartbeat finalize; retire JSONL recovery.**
- **Phase 5 — per-turn ACL, retention, protocol versioning.**
- **Phase 6 — cutover (default `redis`; extend to driver/review/gate/autofix).**
