# Realtime Query Engine — Implementation Plan

## Status

- **Phase 0 (package core) — ✅ COMPLETE & GREEN** (typecheck clean, 13 suites / 87 tests, tsup CJS+ESM build). New files in `submodules/pg-realtime/src/`: `engine/diff.ts`, `bus/redis-bus.ts`, `socketio/parser-superjson.ts`, `socketio/mux.ts`, `client/realtime-client.ts`, `rtk/socket-opener.ts` (+ tests). Edited: `types.ts` (`RowDelta.changedColumns`, `ChangeEvent.oldRow` already existed, `ModelConfig.replicaIdentityFull`), `engine/matcher.ts`, and the barrel exports. `jest.config.cjs` gained a `transformIgnorePatterns` entry for superjson's ESM-only deps. Not committed (awaiting review).
- **Phase 1 (`job` feature end-to-end) — ✅ CODE-COMPLETE & GREEN** (backend typecheck clean; web typecheck clean; package still 87 tests + build). Backend: `_lib/realtime/realtime.decorators.ts` (`@Realtime`/`@Expose`), `_lib/realtime/build-realtime-models.ts` (discovery from TypeORM metadata), `host/realtime/realtime.{gateway,module}.ts` (socket.io on the app http server, `access_token`-cookie auth via `JwtService`, `attachMux`); 6 job entities decorated; `forRootAsync` feeds discovery models; bus → `RedisBus` on `REDIS_URL`; `job.realtime.ts` + job `@Sse` endpoints deleted (turn stream + org/repo/agent-cred SSE untouched). Migration `1784836695849-JobRealtimeReplicaIdentityFull.ts` created (NOT yet run). Web: singleton `RealtimeClient` (`withCredentials`) + `jobs.api` opener swap; `getThreads` filter corrected to `{ jobId }`. Package: `lsn.ts` BigInt literal → `BigInt()` for ES2017 consumers; `RealtimeClient` gained `withCredentials`. **Runtime steps owed by operator: run the migration, ensure `REDIS_URL` set, restart backend, test `job` live.** Not committed.
- **Phase 2a (repo / org / agent-credentials direct feeds) — ✅ CODE-COMPLETE & GREEN** (package 88 tests, backend + web typecheck clean). Decorated `repos`, `organizations`, `organization_members` (composite PK — discovery `build-realtime-models` fixed to emit `string[]`), `agent_credentials`; deleted their `*.realtime.ts` + direct `@Sse`; migration `1784839787644-Phase2RealtimeReplicaIdentityFull.ts`. Derived fields moved client-side: org `role` (join `organizations`+`organization_members` in `auth.api`), agent-cred `plan`/`usage` (pure fns moved to `shared/src/agent-credentials/`, computed in the consuming component). Members feed (`email`/`name` `users` join) intentionally LEFT on old SSE → Wave 2b.
- **Post-launch fixes (live):** superjson parser `Decoder` gained `removeListener` (socket.io calls it on every teardown — its absence crashed the backend on any disconnect); `mux` now logs auth rejections; gateway attaches via `HttpAdapterHost` + `access_token` cookie. Realtime verified working end-to-end.
- **Stateless-matcher refactor — ✅ DONE & GREEN** (98→ tests). Live FULL-table subscriptions classify from `match(old)`/`match(new)` with no `documentIds` consulted (legacy set kept only for replay-dedup + non-FULL fallback). Minor residual: snapshot-era PK set not force-freed on live transition (bounded, non-growing — trimmable later).
- **Composed-resource mechanism — ✅ DONE & GREEN** (103 tests). `attachMux` gained `resolveResource` + `ComposedResource` (`triggers` + `load()` → re-run on any trigger change → ordered `data` snapshot; coalesced). Client unchanged (composed uses the `data` reconcile path).
- **Phase 2b (org-members + cleanup) — ✅ CODE-COMPLETE & GREEN**. Backend: `RealtimeResourceRegistry` (`@Global` `RealtimeResourceModule`) + gateway `resolveResource` wiring with **CLS-seeding** (`cls.run` + `CLS_USER=principal`, so composed `load()`'s `db.scoped` sees real RLS claims off-socket); `org_members` resource registered from `OrgModule` (`org-realtime-resources.service.ts`) → `OrgService.membersOf`. Deleted `streamMembers` `@Sse` + `SseSnapshotService`/`sse-snapshot.module` + `sse-opener.ts`. **Phase 2 DONE — all features (job/org/repo/agent-cred incl. members) on the single socket; old SSE realtime infra gone (turn stream aside).** Owed: run migration `1784839787644` (+ restart). Not committed.
- **Mode B (windowed sort/limit) — ✅ DONE & GREEN.** Protocol (`QuerySpec`: `sort`/`limit`/`offset`/`after`) end-to-end; the NestJS layer's `resolveResource` dispatches windowed subs to a `scopedFind` plug that refetches `ORDER BY … LIMIT` (RLS-scoped, `@Expose` projection, sortable-column guardrail, offset — keyset `after` throws-not-faked). Known scale TODO: windowed trigger opens a full streaming sub as a signal (snapshots the filtered set once).
- **Reusable extraction (E1–E3) — ✅ DONE & GREEN across all trees** (pg-realtime 122 tests, nestjs-rls 25 tests, backend + web typecheck clean). Generic glue moved OUT of Atlas into the shared submodules, cycle-free via plugs:
  - **`@workspace/nestjs-rls`**: `@Expose` + `getExposed` (field-level visibility, sibling to `@Rls`).
  - **`@workspace/pg-realtime/nest-realtime`**: `@Realtime`, `buildRealtimeModels` (plug-based), `RealtimeResourceRegistry`, and `RealtimeNestModule.forRootAsync({ dataSource, engine, authenticate, withPrincipalContext, resolveExposed, buildGuard, scopedFind?, path?, cors? })` — socket server + engine + discovery + gateway + Mode A/B/composed dispatch, all behind plugs (never imports nestjs-rls).
  - **Atlas** now a thin consumer: entity decorations + `AtlasRealtimeModule` (auth `RealtimeAuthService`, `ScopedFindService`, CLS `withPrincipalContext`) + `org_members` registration + `engineConfig`. Deleted its 6 glue files. A new project adopts realtime with one `forRootAsync` + ~5 plugs.
- **E4 (adoption READMEs) — in progress.** **Then:** CQS read-endpoint teardown (delete GET query endpoints, one-shot query helper); later turn-stream fold + scale hardening.

## Design revisions (2026-07-23) — server is a stateless notifier; two query modes

Refined after review. **These supersede any conflicting wording below.**

**The server holds NO materialized result set.** Per subscription it stores only the **filter** (a small mingo predicate) + the socket. It is a stateless notifier: for each WAL change it tests the filter against the OLD and NEW row (both free from the event, since published tables are `REPLICA IDENTITY FULL`) and forwards or skips:
- `match(new)` & not before → **add** (full row) · matched before & still → **update** (field patch) · matched before & not now → **remove** · else skip · delete: `match(old)?remove:skip`.
- The `documentIds` set is redundant given FULL — `match(old)` replaces "was it in the set?". Fallback to a per-sub set ONLY when `oldRow` is absent (non-FULL table / TOAST-incomplete).
- **The client owns the materialized set** (its normalized `Map<pk,row>`), exactly like Firebase's client cache. Consequence: 1000 users × 10 rows = ~0 server RAM (1000 tiny filters), not 10k rows resident. Unbounded-on-huge-collection is now a *client* memory/bandwidth concern (user's responsibility, like Firestore), not a server risk.

**Two subscription modes:**
- **Mode A — unbounded stream** (filter only): stateless-notifier path above; field-level patches; client holds & sorts/slices the full set.
- **Mode B — windowed DB query** (`sort` + `limit` + `offset`/keyset `after`, and/or joins/rank/aggregates): the server owns a scoped SQL query. On a change that **matches the filter**, it **re-runs the `ORDER BY … LIMIT` query and pushes the fresh ordered rows** (ordered `data` snapshot; ≤ `limit` rows so it's cheap). DB-authoritative, always correct, RLS-scoped via `db.scoped`. This is the composed-resource registry generalized (joins + sort/limit share one "re-run-on-relevant-change → ordered snapshot" mechanism).

**Query surface = hybrid:** clients may pass `sort`/`limit`/`offset`/`after` on exposed entities (Firebase-like `orderBy().limit()`, RLS-scoped, sortable/filterable columns allowlisted + index-guided) AND subscribe to server-defined named resources for joins/aggregates/complex rank.

**No hard default limit** (silent truncation is worse than a big fetch, and the server is safe by design now). Optional advisory soft-warning above a threshold; pagination (offset + keyset cursor) is a client UX/perf tool, the user's call — like Firebase.

**Socket `path` is configurable** on gateway + client (default a dedicated non-`/socket.io/` path) so pg-realtime coexists with a project's existing socket.io/ws layer; the superjson parser is scoped to our `Server` instance only.

## Goal

Replace the current per-endpoint SSE realtime layer with a **single-connection, GraphQL-style live-query engine** built on the packages we already own (`@workspace/pg-realtime` + `@workspace/nestjs-rls`). Clients open **one socket**, subscribe to server-published resources by name (selecting fields + filters within an RLS-scoped envelope), and receive minimal field-level patches. All **reads** become live queries; all **writes** become command/action RPC endpoints (CQRS with a reactive read model).

This is a **consolidation, not a rebuild** — the WAL capture, the RLS gate, and the re-run-on-delta engine already exist. We are adding: field-level diffing/patches, a multiplexed socket transport, a Redis bus, declarative secure-by-default publishing, and a framework-agnostic client SDK.

### Non-goals / deferred
- No staged-rollout flags (single-operator R&D; we cut over per-feature by replacing code).
- No durable per-client event queues / missed-event replay (reconnect = re-snapshot + client reconcile).
- No socket.io Redis *adapter* (matching + emit is server-local; Redis is only the change bus).
- `since-lsn` reconnect fast-path, coarse-channel bus sharding, subscription indexing — **scale hardening, Phase 5**, only when a project needs it.

---

## Architecture

```
Postgres WAL
   │  logical slot — ONE leader process holds it (advisory lock)
   ▼
LEADER: decode pgoutput → FULL-diff old/new → ChangeEvent{ table, pk, op, patch, lsn }
   │
   ▼  RedisBus.publish()                         ← the change bus (Redis pub/sub)
   ├───────────────┬────────────────┐
   ▼               ▼                ▼
 server A        server B         server C        (every server subscribes; gets every event)
   │ local matcher: test event vs subs of ITS OWN connected clients (mingo + changedColumns)
   ▼
 ONE socket.io connection per client, MUXED by subId  (superjson parser → Date survives)
   ▼
 RealtimeClient SDK: normalized cache, apply snapshot/patch, route by changed field → component
```

**Layer ownership**
- **Server compares** (FULL diff, once per event) → emits patches.
- **Client caches + routes** (never re-diffs) → per-field re-render suppression.
- **RLS is the one gate** (`@Rls` mingo policy) — same predicate on the SQL snapshot and the live matcher; nothing client-side.
- **Client owns its subscription list** — server per-socket state is ephemeral; client replays subs on every (re)connect.

---

## Locked design decisions

| Decision | Choice | Rationale |
|---|---|---|
| Transport | socket.io, single multiplexed connection | bidirectional (sub/unsub/select on one pipe); reconnection built-in |
| Serialization | superjson custom socket.io parser | `Date`/`Map`/`BigInt` survive the wire |
| Field diff | `REPLICA IDENTITY FULL` per published table, diffed once at the leader | correct, no cold-start, diff-once-not-per-client; per-table so wide/hot tables can opt out |
| Wire shape | full snapshot on subscribe; `add`/`remove` full row; `update` = **patch of changed exposed fields only** | minimal bytes; patch keys ARE the changed-set the client routes on |
| Re-render suppression | client-side, by patch keys | server doesn't track per-sub field selection (simpler); client ignores patches for unselected fields |
| Publishing | `@Realtime()` class decorator + `@Expose()` per-column, discovered at boot | secure-by-default: undecorated entity = not subscribable; undecorated column = never leaves the server |
| Reads | live queries (subscription) or one-shot query over the same socket | zero REST GET endpoints |
| Writes | command/action RPC endpoints (unchanged) | CQRS |
| Change bus | `RedisBus implements PubSubBus` | replaces `PgNotifyBus`; no 8KB NOTIFY cap; scales to N servers |
| Reconnect | re-subscribe + fresh snapshot + client reconcile against cache | no durable queues; slot retains WAL for leader failover |

---

## Wire protocol

All messages over the one socket are `{ subId, ... }`; superjson-encoded.

**Client → server (control)**
- `subscribe { subId, model, filter?, /* selectedFields optional, Phase 5 */ }`
- `unsubscribe { subId }`
- (auth: JWT in the socket handshake `auth`; re-sent on every reconnect)

**Server → client (data)**
- `{ subId, op: 'data',   rows: [{ pk, row }] }`  — snapshot, full exposed columns, once per subscribe
- `{ subId, op: 'add',    pk, row }`              — row entered result set (full exposed row)
- `{ subId, op: 'update', pk, patch: {...} }`     — **only changed exposed fields**
- `{ subId, op: 'remove', pk }`                   — row left result set
- `{ subId, op: 'error',  message }`

`add`/`remove` fire on membership change regardless of field selection; only `update` is field-routed.

---

## Work breakdown

### A. `@workspace/pg-realtime` (the reusable core)

1. **FULL-diff → patch emission**
   - `engine/normalizer.ts`: capture the **old tuple** from pgoutput UPDATE messages (present when the table is `REPLICA IDENTITY FULL`; fall back to "all columns changed" if absent so behavior is safe without FULL).
   - New `engine/diff.ts`: `changedColumns(oldRow, newRow) → Set<col>`, computed **once per `ChangeEvent`** at the leader.
   - `types.ts`: extend `ChangeEvent` with `changedColumns`; extend `RowDelta` `update` variant with `patch` (subset of mapped row).
   - `engine/matcher.ts`: on the `update & in-set & pass` transition, emit `patch = mapRow(new) ∩ exposed ∩ changedColumns`; **suppress the emit if that patch is empty**. `add`/`remove`/enter/leave transitions unchanged (full row / pk).
   - `ModelConfig`: add `replicaIdentityFull?: boolean` (documentation/validation hint) and keep `mapRow` as the projection.

2. **superjson socket parser** — new `socketio/parser-superjson.ts`: `Encoder`/`Decoder` wrapping superjson; exported for `new Server(http, { parser })`.

3. **Multiplexed socket gateway (server)** — new `socketio/mux.ts`: `attachMux(io, engine, { authenticate })`.
   - One connection = many subscriptions. Handle `subscribe`/`unsubscribe`; hold ephemeral `Map<subId, Subscription>` per socket.
   - Pipe each `Subscription.on(delta)` → `socket.emit('rt', { subId, ...delta })`.
   - `authenticate(handshake) → principal`; resolve claims once per connection; re-run on reconnect.
   - Tear down all subs on `disconnect`.
   - (Supersedes the existing one-socket-per-subscription `socketio/index.ts` binding for this use; keep the old one or deprecate.)

4. **RedisBus** — new `bus/redis-bus.ts`: `implements PubSubBus` over Redis pub/sub. Single firehose channel to start; interface unchanged so the engine doesn't care. (Coarse-channel keying by `table`+`coarseScope` = Phase 5.)

5. **Framework-agnostic client** — new `client/realtime-client.ts`: `RealtimeClient`.
   - Owns the single socket.io connection (superjson parser, JWT auth, backoff).
   - `Map<subId, Collection>`; each `Collection` is a normalized `Map<pk,row>` that applies `data`/`add`/`update(patch)`/`remove`.
   - `query(model, { filter }) → LiveQuery` and `document(model, pk) → LiveDoc`, each a plain emitter: `.subscribe(listener)`, `.select(fields).subscribe(listener)` (fires only when a selected field is in the patch keys).
   - **Reconnect handler**: on every `connect`, replay the full `Map<subId, spec>`; each re-subscribe yields a fresh snapshot; `Collection` **reconciles** new snapshot vs current cache → emits the derived add/update/remove to listeners (only changed fields route to components).
   - No re-diffing of updates — patch keys are authoritative.

6. **RTK binding** — extend `rtk/index.ts`: add a `SocketOpener` backed by `RealtimeClient`, wired into the existing `streamList`/`streamDocument` (they already take an injectable opener). On patch → `updateCachedData(draft => applyPatch(draft, patch))`. Document `selectFromResult` for component-level field memoization.

### B. Atlas backend

7. **Decorators + discovery** (`backend/src/_lib/realtime/`)
   - `@Realtime()` class decorator (publish marker) + `@Expose()` property decorator (column allowlist), via `reflect-metadata` — mirrors how `nestjs-rls` stores `@Rls`.
   - `realtime-discovery.service.ts`: at boot, enumerate entities carrying `@Realtime`, and for each build a `ModelConfig`:
     - `table` / `primaryKey` from TypeORM `getMetadata()`.
     - `mapRow` **auto-generated** from column metadata (snake→camel), **restricted to `@Expose()` columns** (secure-by-default; forget to expose → never streamed).
     - `guard: rlsGuard(Entity, resolveClaims)` (existing bridge).
     - `replicaIdentityFull: true`.
   - Register the flattened `ModelConfig[]` into the engine (replaces every `PgRealtimeModule.forFeature` + `*.realtime.ts`).

8. **Composed-resource registry** (`composed-realtime.registry.ts`) — generalize `SseSnapshotService`: `register(name, { triggers: string[], load: (db, params, claims) => Promise<Row[]> })`. The gateway resolves `model` names against both entity resources and composed resources; composed ones open trigger subscriptions and re-run `load()` (RLS applied inside via `db.scoped`) on any trigger delta. Retire `_lib/realtime/sse-snapshot.service.ts`.

9. **Gateway** (`backend/src/host/realtime/realtime.gateway.ts`) — mount `attachMux(io, engine, { authenticate })`; `authenticate` validates the JWT and produces the principal; claims resolved via the existing `RLS_CONTEXT.resolveClaims`. One socket endpoint for the whole app.

10. **Migration — `REPLICA IDENTITY FULL`** (hand-written raw SQL, the one exception to "migrations via generator" because TypeORM has no concept of replica identity): `ALTER TABLE <t> REPLICA IDENTITY FULL;` for every `@Realtime` table. Also fold these tables into the pg-realtime publication.

11. **Bus swap** — `_lib/realtime/realtime.config.ts`: `PgNotifyBus` → `RedisBus`. Leader elector unchanged.

12. **Delete the old realtime layer** — remove `host/{org,job,repo,agent-credentials}/*.realtime.ts`, their `@Sse` controller methods, and `forFeature` blocks. Legacy `host_old/realtime/*` already dead.

13. **Reads → live queries; enforce command-only RPC** — audit existing GET endpoints; replace each with either a published resource (live) or a one-shot query over the socket (subscribe → first snapshot → close). Remaining HTTP endpoints are commands/actions only.

### C. Atlas web

14. **Realtime client** (`web/src/lib/realtime/`) — instantiate the `RealtimeClient` (single socket) as an app singleton; wire JWT + refresh.
15. **RTK cutover** — repoint `redux/query/api/{jobs,org,repo,agent-credentials}.api.ts` from the SSE openers to the `SocketOpener` + `streamList`/`streamDocument`. Use `selectFromResult` where components read a narrow field slice.
16. **Remove the SSE stack** — delete `lib/api/sse-manager.ts`, `redux/query/api/sse-opener.ts`, `use-job-turn-stream.ts` EventSource usage, and the per-domain openers.

---

## Phased rollout (always green)

- **Phase 0 — Package core.** Items A1–A6 in `pg-realtime`, unit-tested in isolation (diff/patch, matcher transitions, reconnect reconcile, superjson roundtrip). No Atlas change yet.
- **Phase 1 — One feature end-to-end.** Backend items 7–11 for **`job` only**; stand up the gateway; migrate `job` to `@Realtime`/`@Expose`; web `jobs.api` onto the socket. Leave other features on old SSE. Validate live in-app (manual — Dennis tests feel).
- **Phase 2 — Migrate remaining features.** `org`, `repo`, `agent-credentials` → decorators + discovery; delete their `*.realtime.ts` (item 12).
- **Phase 3 — CQRS cutover.** Item 13: reads → live queries / one-shot; strip READ endpoints.
- **Phase 4 — Web SSE removal.** Item 16; single socket is the only realtime transport.
- **Phase 5 — Scale hardening.** Coarse-channel Redis sharding, subscription indexing by `table`+`coarseScope`, `since-lsn` reconnect fast-path for large result sets. Only as needed.

---

## Testing

- **Engine unit** — `changedColumns` diff; matcher patch/suppression on each transition; empty-patch suppression; TOAST-incomplete + `refetchOnUpdate` still works.
- **Client unit** — apply snapshot/patch; reconcile-on-resnapshot produces correct derived deltas; `.select(fields)` fires only on selected-field patches; Date survives superjson.
- **Integration** — RLS enforced on snapshot AND live patch (reuse existing realtime int tests); reconnect after server kill replays subs + reconciles; leader failover (kill leader, assert no lost changes via slot); permission change on reconnect drops now-forbidden rows.
- **Load smoke** — N subscriptions on one socket, one WAL change fans out correctly to only matching subs.

---

## Open decisions / risks

1. **`REPLICA IDENTITY FULL` WAL cost** on any wide+hot published table — audit table widths; opt specific tables out of FULL (accept full-row updates / client-diff there) if needed.
2. **Snapshot size on reconnect** for large result sets — acceptable initially; `since-lsn` fast-path deferred to Phase 5.
3. **Long-lived socket auth** — JWT expiry mid-connection: re-auth on reconnect covers drops; add a token-refresh-over-socket message if connections outlive token TTL.
4. **superjson × socket.io binary** — verify the custom parser handles binary/ack packets; fall back to payload-level superjson if the parser fights socket.io internals.
5. **One-shot query semantics** — define the "subscribe → snapshot → auto-close" helper so no REST GET sneaks back in.
