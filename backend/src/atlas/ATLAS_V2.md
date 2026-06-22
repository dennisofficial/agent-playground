# Atlas v2 — canonical reference

> Single source of truth for the clean-room orchestrator in `backend/src/atlas/`. Written 2026-06-20 after the overnight W0–W9 build. Read this first when resuming Atlas work (esp. the Docker sandbox rework). Full design history: `/Users/dennis/.claude/plans/this-ai-orchestrator-is-greedy-parnas.md`.

## 1. Why this exists

v1 (`backend/src/harness/`) had already collapsed to one chat employee (Atlas) + non-chat phase roles and already did section-driven JIT planning / one-branch / one-PR. The disease was *how* it was built: `pipeline-runner.service.ts` (1,849 LOC) was an **implicit FSM** re-entered via `status` enums across 5 tables on racing async signals; execution was **daemon-only** (a 7,200-LOC Docker/daemon sandbox stack); the module graph was board-coupled throughout. Too fragile to evolve.

Atlas v2 re-implements the proven semantics **legibly and daemon-free**, in a **clean room with ZERO imports from v1** (`harness/**` or v1 `slack-app/**`). Anything wanted from v1 was copied/rewritten. v1 is still intact beside v2 (deletion = W8, intentionally **not done** — held for Dennis's review; it's irreversible and not needed to plan Docker).

**Goal:** automate Dennis's real workflow — chat → plan → Codex review → revise → approve → execute in sections/phases → self-review → one PR — AND react autonomously to notifications (alert → fix → PR). Dennis only reviews **system decisions + PRs**.

## 2. The locked design model

**Brain vs hands.** `Atlas = brain`: a small conversational/reactive decider (triage → ignore/ask/dispatch; grill → decision record + section list). The `pipeline = hands`: a plain deterministic `async` driver that walks a planner-emitted list — **legible top-to-bottom, NOT an implicit FSM**. Dynamism (count of sections/phases) is data the planner emits; control flow stays a readable loop. Explicit step-state rows exist only so `resume()` knows where to re-enter.

**Tenancy.** `Tenant` (Slack workspace = `team_id`) ⊃ `Projects` (GitHub repos) ⊃ `Channel` (**1:1 per project**) + per-feature **sandbox** (`local` = a git worktree; `docker` = a per-feature container — same abstraction, see §8). Channel-per-project: notifications route to the project's channel; collapses to one channel for single-repo tenants.

**Work model.** A `job` = an ordered list of `sections` (e.g. backend → frontend → devops). Two-level planning: (1) upfront grill → a **locked decision record** + high-level section list, approved once; (2) per-section just-in-time detailed phase plan. **Sections stack on ONE feature branch**; phases run as **sequential fresh engine sessions** on that shared checkout (fresh context per phase to dodge 300k rot; shared tree so later sections build on earlier code). **Isolation is per-feature/sandbox** (parallel features = separate sandboxes), NOT per-phase. **One PR per feature.**

**Gates / autonomy (adaptive).** Approve the high-level plan once; sections auto-run unless a planner hits an **always-ask** decision class not covered by the record → park & ask async. Always-ask: data-model/schema, public/cross-service API contracts, new deps, infra/topology, cross-cutting patterns (auth/caching/state/concurrency/error-handling), one-way doors. Never-ask: internal structure, naming, file placement, test layout, refactor mechanics. The always-ask gate doubles as a **security control** for untrusted events.

**Two adapters, one brain.** `ChatSurface` (duplex: post/react/`inbound$`, threaded) vs `NotificationSource` (inbound-only, one custom adapter PER gateway). Both converge to a `Stimulus` subtype: `ChatStimulus` (continues a thread; trusted) or `EventStimulus` (opens a NEW thread; `trust:untrusted`; has `dedupeKey`+`severity`). A notification **seeds a thread** then all duplex happens over the ChatSurface. Notifications announce a headline in the channel timeline; job chatter lives in the thread. Many histories = one `atlas_messages` table by `thread_id`; cross-thread coherence = shared memory only.

**Engines from scratch, minimal.** Just: invoke Claude/Codex in plan/review/execute modes, thread credentials (api_key | subscription), and pin an **isolated agent home** (`CLAUDE_CONFIG_DIR`/`CODEX_HOME` under `ATLAS_AGENT_HOME_ROOT`, never `~/.claude`/`~/.codex`). **No skills/MCP loader** (dropped — "honestly sucks"). **No boards/backlogs.**

## 3. Module map (`backend/src/atlas/`, zero v1 imports)

| Area | Key files | What it provides |
|---|---|---|
| Foundation | `atlas.module.ts`, `atlas-main.ts`, `persistence/atlas-database.module.ts` (`ATLAS_CONNECTION='atlas'`), `persistence/entities/`, `cli/atlas-data-source.ts`, `migrations-atlas/` | Own TypeORM datasource (separate named connection, own migrations history `atlas_migrations`), 11 `atlas_*` entities, standalone HTTP entrypoint |
| Domain | `domain/` | `Stimulus`(`ChatStimulus`/`EventStimulus`), `Job`, `Section`, `Phase`, `DecisionRecord`, `Decision`, `DecisionClass`, `SessionRef`, `JobKind='feature'|'bugfix'`, `NotificationSource` port |
| Engines | `engine/engine-runner.service.ts` (`EngineRunner`), `engine/claude-auth.ts`, `engine/codex-auth-home.ts`, `engine/engine-home.ts`, `engine/esm.module.ts` | Run one Claude/Codex turn (plan/review/execute), isolated home, creds. ESM SDKs via dynamic import |
| Git/PR | `git/local-git.service.ts` (`LocalGitService`: ensureRepo, createFeatureSandbox=worktree, commitAll→sha, push, headSha, removeSandbox), `git/github-pr.service.ts` (`GithubPrService`: openPullRequest idempotent, markReadyForReview, commentOnPullRequest), `git/git-auth.ts` (`gitAuthEnv` — token via `GIT_CONFIG_*`, never in argv/.git/config) | Host git worktrees + fetch-based PR client, daemon-free |
| Surface | `surface/chat-surface.port.ts` (`CHAT_SURFACE`), `surface/atlas-slack-surface.ts` (thread-aware: `post(thread_ts)`, inbound carries `threadTs`), `surface/approval-blocks.ts` (copied pure renderer), `surface/surface.module.ts` (`ATLAS_SURFACE` switch) | The chat edge |
| Agent surface | `agent-surface/agent-chat-surface.ts` (`AgentChatSurface`) | In-process `CHAT_SURFACE` to DRIVE Atlas without Slack: `sendFromHuman`, `outbound$`, `waitForReply`, `waitForApprovalCard`, `reset()` |
| Intake | `stimulus/stimulus-intake.service.ts` (`StimulusIntake`), `stimulus/stimulus-consumer.ts` (`STIMULUS_CONSUMER` token), `stimulus/event-filter.service.ts` (dedup+rate-limit, no LLM), `stimulus/stimulus-store.service.ts` (seeds thread), `stimulus/project-routing.service.ts`, `stimulus/chat-stimulus.bridge.ts`, `stimulus/untrusted-content.ts`, `stimulus/surface-orchestration.service.ts` (announce headline + backfill thread root); `ingress/github-notification.source.ts` (HMAC `X-Hub-Signature-256`), `ingress/generic-webhook-notification.source.ts`, ingress controllers `POST /ingress/github` + `POST /ingress/webhook` | The notification edge + the one-Stimulus convergence |
| Brain | `brain/triage.service.ts` (`TriageService` = bound `STIMULUS_CONSUMER`), `brain/conversational-brain.service.ts` (grill), `brain/decision-approval.service.ts`, `brain/job-dispatcher.ts` (`JOB_DISPATCHER` token), `brain/brain-store.service.ts`, `brain/brain-llm.ts` (`ATLAS_BRAIN_LLM`) | Decide whether/what; produce + approve the plan; dispatch |
| Decision gate | `decision-gate/decision-classifier.service.ts` (`classify→'covered'|'proceed'|'ask'`), `decision-gate/park-and-ask.service.ts`, `decision-gate/plan-visibility.service.ts`, `decision-gate/classifier-llm.ts` (`ATLAS_CLASSIFIER_LLM`) | Always-ask/never-ask + park |
| Driver (the hands) | `driver/section-driver.service.ts` (`SectionDriver` = the real `JOB_DISPATCHER`; `dispatch`→`drive`→`runJob`→per-section `runSection`→`finishWithPr`; `resume()` on boot), `driver/driver-store.service.ts`, `driver/planner-llm.ts` (`ATLAS_PLANNER_LLM`), `driver/repo-resolver.ts` (`ATLAS_DRIVER_REPO`) | The deterministic legible pipeline |
| Auto-fix | `autofix/autofix.stage.ts` (`AutoFixStage`: `autofixSection`, `autofixPullRequest`), `autofix/autofix-lenses.ts` (3 lenses: best_practices/correctness/consistency) | Parallel review/fix fan-out → commit |
| Verification | `gate/gate-main.ts` + `gate/acceptance-gate.service.ts` (`atlas:gate`, W1 substrate proof), `e2e/e2e-main.ts` + `e2e/e2e-harness.service.ts` + `e2e/e2e-stubs.ts` (`atlas:e2e`, 3 scenarios), `atlas-boot.int.test.ts` (DI boot guard) | Live + offline verification |

**The two extension seams (mirror each other):** W2→W3 binds `STIMULUS_CONSUMER` → `TriageService`; W3→W4 binds `JOB_DISPATCHER` → `SectionDriver` (each later workstream removed the earlier module's no-op binding; `@Global` modules so injection resolves with zero changes elsewhere).

## 4. Persistence (own datasource, namespaced `atlas_*`)

Separate `'atlas'` TypeORM connection (NOT the shared global `ENTITIES`), own migrations dir `migrations-atlas/` + history table `atlas_migrations`, against the same Postgres. Tables: `atlas_teams`, `atlas_projects`, `atlas_channels` (1:1 project), `atlas_threads`, `atlas_messages` (by `thread_id`), `atlas_stimuli` (chat/event subtype + `dedupe_key`, partial-unique dedup index), `atlas_jobs`, `atlas_sections` (gap-numbered ordinal), `atlas_phases` (explicit `step`+`status`), `atlas_decision_records`, `atlas_memory` (pgvector `vector(1536)` + HNSW). No board/team-task tables.

**Job lifecycle:** `scoping` → `awaiting_approval` → `running` → `done` (terminal PR state = `done` WITH `pr_url`, via `DriverStoreService.setPrReady`); plus `cancelled`, `failed`. Sections: `pending` → `done`. Phases: `step` (e.g. `build`) + `status` (`pending`→`building`→`done`).

> Note: `vitest.global-setup.ts` was extended to run the atlas migrations into the test DB (W4 needed it because boot-time `resume()` queries `atlas_jobs`).

## 5. How to run / verify

```
pnpm -C backend atlas:dev          # boot the standalone Atlas app (HTTP + chosen surface)
pnpm -C backend db:atlas:migrate   # apply atlas migrations (already applied to dev DB)
pnpm -C backend db:atlas:migration:generate <Name>
pnpm -C backend vitest run src/atlas                         # 187 tests, all green
pnpm -C backend vitest run src/atlas/atlas-boot.int.test.ts  # DI boot guard

# W1 substrate gate (real engine turn → Slack thread → PR):
pnpm -C backend atlas:gate -- --live --repo <url> --channel <id>   # dry-run without --live

# Full end-to-end (feature + autonomous + injection scenarios), agent surface:
ATLAS_GITHUB_WEBHOOK_SECRET=<secret> pnpm -C backend atlas:e2e -- --live --repo <url>
```
Env loads via `pnpm dev:env` = `dotenvx run -f .env.local.enc -f .env.personal`. **Key env vars** (all optional, in `_core/config/env/validation.ts`): `ATLAS_SURFACE`(slack|agent, default slack), `ATLAS_HTTP_PORT`(4002), `ATLAS_GITHUB_TOKEN`/`GITHUB_TOKEN`, `ATLAS_GITHUB_WEBHOOK_SECRET`, `ATLAS_WEBHOOK_SECRET`, `ATLAS_REPOS_ROOT`, `ATLAS_AGENT_HOME_ROOT`, `ATLAS_ENGINE_AUTH_MODE`(api_key|subscription), `ATLAS_CLAUDE_OAUTH_TOKEN`, `ATLAS_EVENT_DEDUP_WINDOW_S`, `ATLAS_EVENT_RATE_LIMIT`/`_WINDOW_S`, `ATLAS_MAX_SECTIONS`(12), `ATLAS_MAX_PHASES_PER_SECTION`(8), `ATLAS_WORKER_MODEL`/`ATLAS_CODEX_MODEL`. Reuses `ANTHROPIC_API_KEY`, `CHAT_MODEL`/`GATE_MODEL`, `POSTGRES_*`, `SLACK_BOT_TOKEN`/`SLACK_APP_TOKEN`.

Dev env (`backend/.env.personal`): first 3 keys (Anthropic/OpenAI/`GITHUB_PAT`) are UNCOMMENTED; appended `ATLAS_GITHUB_TOKEN=${GITHUB_PAT}` so atlas finds the token under its own name. The Slack test workspace: team "DL Technologies LLC", bot `ai_crew_dev`, channel `C0B9L9BB891` = `#ai-crew-local-testing`. GitHub origin = `dennisofficial/ai-crew` (the local dir is "agent-playground"; the repo is "ai-crew").

## 6. Build status (2026-06-20)

All build workstreams **W0–W9 DONE**; **W8 (delete v1) DONE** — v1 `harness/**` removed in commit `f82a748` on `main`, atlas is the sole orchestrator. **The Docker sandbox layer is also BUILT + verified** (see §8). 198 atlas tests green (unit + Docker/Postgres integration), full graph boots, zero v1 imports.

**Proven LIVE end-to-end:** the W1 gate (real engine turn → Slack thread → PR #44) AND a full chat-driven feature drive that opened **`dennisofficial/ai-crew#45`** (grill → approve → section "investigate" → section "write README" committed → 3-lens auto-fix found+fixed 2 issues → PR-tail → PR). `resume()` reconciles interrupted jobs (it correctly 422'd a stale empty-commit job on reboot). Offline e2e (fake LLM): all 3 scenarios pass deterministically.

**Bug found + fixed during W9:** mid-grill, a human follow-up was being **re-triaged and dropped** (continuity check looked for an open *job*, but none exists during the question phase). Fixed by anchoring a `scoping` job at triage time (`triage.service.ts`); regression-tested in `triage.service.spec.ts`.

## 7. OPEN tuning/design items (Dennis's to dial in — NOT architectural, orthogonal to Docker)

1. **Builds are slow** (~7 min for a trivial README change). The planner inserts an "investigate" section first and runs the 3-lens auto-fix on *every* section incl. zero-change ones. Many LLM turns for small work. Tuning: planner shouldn't over-decompose; skip auto-fix on 0-change sections; the e2e PR poll (now 420s in `e2e-harness.service.ts`) still missed PR #45 by ~6s.
2. **Autonomy/security triage is non-deterministic.** The real triage LLM sometimes PARKS an untrusted event (safe), sometimes summarizes it as a benign job and DISPATCHES (e2e runs 1-2 parked the injection; run 3 dispatched a benign "fix CI failure"). The injected **destructive action never executed**, but the triage-level guard isn't reliable — it relies on the driver's per-section gate as defense-in-depth. **RECOMMENDATION: move the autonomy gate out of triage** (which classifies an *unplanned* fix it can't verify) **into the driver's per-section gate** (where real decisions are known) — both more deterministic and the right layer. The classifier itself is deterministic on rules; the non-determinism is the triage LLM's event→summary step.
3. **e2e hygiene:** boot-time `resume()` re-attempts prior runs' stale jobs before the harness's `purgePriorRun` runs.
4. **Test artifacts on `ai-crew`:** draft PR #44 (gate), PR #45 (e2e feature), + stray `atlas/feature-*` / `atlas/bugfix-*` branches — safe to close.

Convention: Dennis tunes conversational/UX behavior himself; ship + flag, don't burn billed runs on subjective feel (`no-self-billed-behavior-validation` memory).

## 8. Docker sandbox layer (BUILT — `backend/src/atlas/sandbox/`)

Built 2026-06-20 (plan: `/Users/dennis/.claude/plans/this-ai-orchestrator-is-greedy-parnas.md`). Engine turns now run inside a **long-lived, privileged, network-isolated per-feature container** (DinD-capable), driven one turn at a time by one-shot `docker exec` — **no in-container daemon, no Redis** (v1's fragility, gone). The brain / driver / decision-gate / PR logic is **unchanged**: only *where a turn executes* moves, behind two @Global DI ports selected by **`ATLAS_SANDBOX_MODE=local|docker`** (default `local` = byte-identical to host execution).

**The two seams** (mirror each other): `ENGINE_RUNNER` (`engine/engine.types.ts`) — `EngineRunner` (in-process) or `DockerEngineRunner` (exec in a sandbox); `SANDBOX_PROVIDER` (`sandbox/sandbox-provider.port.ts`) — `LocalSandboxProvider` (no-op) or `SandboxManager` (per-feature container). Bound in `sandbox/sandbox.module.ts` (@Global). The three live exec paths all route through `ENGINE_RUNNER` + carry an `ExecutionTarget`: the driver's phase/plan turns (`runner/turn-runner.service.ts`), the auto-fix review/fix turns (`autofix/`), and the acceptance gate (`gate/`).

| Piece | File | What |
|---|---|---|
| Container seam | `sandbox/container-engine.port.ts` (`CONTAINER_ENGINE`) + `sandbox/dockerode-container-engine.ts` | thin dockerode wrapper: network/image/create/start/**streamed exec**/stop/remove/list/inspect |
| Base image | `sandbox/image/Dockerfile` + `sandbox-init.sh` + `sandbox/sandbox-image.builder.ts` | node+pnpm+git+docker+dockerd + the bundled engine entrypoint + the 2 SDKs; PID1 starts inner dockerd. Boot-memoized build (tag `ATLAS_SANDBOX_IMAGE`, default `atlas-sandbox:latest`) |
| Engine entrypoint | `sandbox/image/engine-entrypoint.ts` → esbuild → `.mjs` (`pnpm atlas:sandbox:bundle`) | runs the SAME `engine/engine-core.ts` (extracted, Nest-free) in-container: stdin JSON spec → NDJSON events → final result |
| Host transport | `sandbox/docker-engine-runner.ts` | `docker exec atlas-engine-turn`, creds via exec ENV, NDJSON→`onEvent`→`EngineRunResult` |
| Lifecycle | `sandbox/sandbox-manager.service.ts` | acquire (reuse-by-name, inner-dockerd readiness poll, soft concurrency cap), teardown, reapStopped; per-sandbox network + DinD volume + privileged |
| Refs | `sandbox/sandbox-refs.service.ts` | host-maintained read-only `/refs` library (mount + clone/fetch; mechanism only) |

**Key decisions (as built):**
- **Checkout = bind-mounted host worktree; git + PR stay host-side, unchanged.** The worktree (and, for a linked worktree, its git common dir) are mounted at their **same absolute host paths** so in-container git resolves and `cwd` needs no translation. The host `LocalGitService` commits after each phase; the GitHub token **never enters the sandbox** (a security plus). Turns exec as the **host uid** so worktree files stay host-owned; the inner-docker socket is opened (privileged, family-trust) so that uid can drive DinD.
- **DinD = `--privileged` + inner dockerd + per-sandbox `/var/lib/docker` volume.** Multi-tenant isolation is by **per-sandbox Docker network** (not privileged-hardening — escape is accepted: family-only host). Proven: an agent runs `docker compose up -d postgres` inside and it's ready in ~2s.
- **Engine home = host-owned dir mounted at `/atlas-home`** (persists sessions across turns/restarts → resume works in-container).

**Verified:** 198 unit/int tests green (incl. Docker integration: `sandbox/*.int.test.ts` build image + run privileged DinD + exec; `sandbox-manager.int.test.ts` proves linked-worktree git + host-uid write). LIVE: a real Claude turn + session-resume in a container (D1); the headline DinD-postgres (D3); and the **assembled path** end-to-end — `ATLAS_SANDBOX_MODE=docker pnpm atlas:gate -- --repo <url>` clones → attaches a container → runs a real in-container turn → host-commits (no PR/Slack in dry-run).

```
pnpm atlas:sandbox:bundle                                   # (re)build the in-container entrypoint bundle (run before image build)
ATLAS_SANDBOX_MODE=docker pnpm atlas:gate -- --repo <url>   # assembled docker proof (dry-run; add --live + --channel for a real PR)
ATLAS_SANDBOX_MODE=docker pnpm atlas:e2e -- --live --repo <url>   # full feature drive, every turn in-container (NOT yet run — billed + opens a PR)
```
**Env (in `_core/config/env/validation.ts`):** `ATLAS_SANDBOX_MODE`, `ATLAS_SANDBOX_IMAGE`, `ATLAS_SANDBOX_REBUILD`, `ATLAS_DOCKER_SOCKET_PATH`(?? `DOCKER_SOCKET_PATH`), `ATLAS_REFS_ROOT`(?? `REFS_ROOT`), `ATLAS_MAX_CONCURRENT_SANDBOXES`. The old v1 `WORKSPACE_*` daemon/redis vars are orphaned (marked deprecated; full prune is a follow-up).

**Open follow-ups (designed, not built):** human-facing dev-server **exposure** (reverse-proxy by hostname / TLS — the next plan; per-sandbox networks + labels are in place); the `/refs` per-repo-token registry + refresh/GC + an agent tool; TTL reaping of idle *running* sandboxes (needs job-state awareness — only stopped ones are reaped now); pinning the in-image SDK versions to the host via build args; rebuild the image for the deploy arch (built linux/arm64 on the Mac; OVH is x64); prune the dead `WORKSPACE_*` env vars; the full `atlas:e2e --live` docker run.

## 9. Durability & session recovery (BUILT 2026-06-20)

**The contract: when a coding agent HALTS for any reason, recovery CONTINUES the same engine session — it does not spawn a fresh one** (unless the halt happened before the session even started, in which case nothing was lost). The whole thing rests on one primitive: the engine `session_id` is persisted on `atlas_phases.session_id`, and any re-run of a phase threads it back as `resume: <session_id>`, so the agent picks up its conversation + its on-disk work.

**The key durability fix — persist the handle at turn START, not just turn end.** `EngineCore` emits a `{kind:'session', sessionId}` event the instant the session exists (Claude `system/init` / Codex `thread.started`) — verified live as the **first** NDJSON frame in docker mode, before any tool runs. `TurnRunnerService` persists it immediately (best-effort, fire-and-forget), so a halt MID-turn still leaves a resume handle. (Previously it was saved only on success → a mid-turn crash would have lost it and respawned fresh.)

**Halt → recovery matrix (all CONTINUE the same session):**
| Halt | Recovery path | Continues? |
|---|---|---|
| Atlas host crash/restart/redeploy mid-turn | boot `DriverModule.onApplicationBootstrap → SectionDriver.resume()` reconciles `running` jobs → re-drives → re-runs the in-flight phase with its persisted `session_id` | ✅ (the sandbox container + `/atlas-home` survive the host restart) |
| Sandbox container dies/restarts | `SandboxManager.attach` reuse-by-name restarts it (or recreates with the SAME `/atlas-home` mount → the session transcript persists) → resume | ✅ |
| 401 / expired credentials mid-turn | pause → ping `resumePaused` (see below) | ✅ |
| Non-auth turn error (SDK/network/tool) | job → `failed`; the `session_id` is saved, so a ping/re-drive resumes rather than restarts | ✅ on re-drive |
| Hung turn | a turn timeout (from the tuning branch, see note) aborts it → re-run resumes the session | ✅ |

### 401 sub-case (pause + ping)

A coding agent hitting a **401 / expired credentials** mid-turn must NOT lose work or restart from scratch — it PAUSES and a ping resumes the SAME engine session. Mechanism:

- **Detect:** the engine classifies auth failures (`engine/engine-core.ts` wraps both engine loops; `isAuthErrorMessage` matches 401 / "not logged in" / invalid key / expired token) and throws a typed **`EngineAuthError`** carrying the live `sessionId`. In docker mode the in-container entrypoint emits `{t:'error', auth:true, sessionId}` and `DockerEngineRunner` reconstructs the typed error.
- **Preserve:** `TurnRunnerService` persists `session_id` onto the phase row *on the auth error* (previously only on success) — the resume handle. The agent's partial edits are already on disk in the (bind-mounted) worktree.
- **Pause, not fail:** `SectionDriver.drive` catches `EngineAuthError` → job status **`paused`** (a new durable `JobStatus`, text column, no migration), posts a "paused — fix creds + ping to resume" note. Non-auth errors still → `failed`.
- **Ping to resume:** `SectionDriver.resumePaused(jobId)` flips `paused→running` and re-drives — `runJob` fast-forwards done sections/phases and re-runs the unfinished phase, which resumes its persisted `session_id` (continues the same conversation; remembers prior work). Exposed for ops/testing as `POST /test/resume {jobId}`.
- **Durable across restart:** paused state + `session_id` live in Postgres. Boot `resume()` deliberately reconciles only `running` jobs — a `paused` job is NOT auto-retried (it'd just 401 again); it waits for a ping. So the operational recovery path is: **401 → paused (durable) → fix credentials → [restart if needed] → ping `resume` → continues the same session.**

**Verified:** early `session_id` persistence LIVE (docker: the `session` event is the first NDJSON frame, before any work) + unit (`turn-runner.service.spec.ts`: the id is persisted even when the turn throws mid-flight, and a prior id is threaded back as `resume`); 401 recovery engine-level LIVE (good→bad→good in-container: bad-key turn returned `auth:true` + the same session id; good-key turn resumed and recalled the turn-1 work) + driver pause/resume unit (`section-driver.service.spec.ts` "401 auth recovery"); **204 atlas tests green**.

**Caveats / follow-ups:**
- **Git divergence (reconcile at merge):** this work is uncommitted atop `f82a748`; `origin/main` is +6 (`c837182`, the "atlas tuning loop" — which added phase/job **timeouts** + failure/progress relay, touching `turn-runner`/`driver`). The early-persist here composes with their timeout (timeout aborts a hung turn → re-run resumes the saved session), but the merge needs a hand-reconcile.
- **No in-process credential hot-swap** (v1's `rotate-keys` is gone): "fix creds" means updating the env (typically a restart), then pinging; the paused job survives. Follow-ups: a `rotate-keys`-style tool that refreshes creds + auto-resumes paused jobs, and a Slack "continue" → `resumePaused` trigger.

---

## 10. Atlas v2.1 redesign — web app + SDK-as-brain, multi-tenant-isolated (BUILT, R0–R6)

> Plan: `/Users/dennis/.claude/plans/this-ai-orchestrator-is-greedy-parnas.md`. Completed in one session (R0–R6, all green).

### 10.1 What changed

**Surface** — `ATLAS_SURFACE=web` binds `AtlasWebSurface` (SSE + REST). The Slack adapter is kept dormant (`ATLAS_SURFACE=slack` still works, all providers always constructed). The web surface controller (`surface/web-surface.controller.ts`) registers at `GET /web/events` (SSE), `POST /web/say`, `POST /web/approve`, `GET /web/thread`, `GET /web/pipeline`. All five control endpoints are **flag-gated** (`ATLAS_SURFACE=web` required — 404 otherwise; `// TODO: authn` marks the authentication follow-up). `GET /web/ping` and `GET /web/channels` are always-on liveness/dev probes. Approval clicks arrive at `POST /web/approve` → `AtlasWebSurface.approval$` → `DecisionApprovalService.resolve` (no circular dep).

**SDK-as-brain** (`brain/agent-session-manager.service.ts`) — replaces `ConversationalBrainService` + `ScopingInvestigatorService` (both deleted). Each chat stimulus runs an in-sandbox Claude Agent SDK session (`AgentSessionManager.handleChatTurn`) with 6 host-side tools:
- `get_pipeline_state` → `DriverStoreService.getPipelineState`
- `get_decision_record` → `DriverStoreService.getDecisionRecord`
- `recall` / `remember` → `AtlasMemoryStore`
- `submit_plan` → `BrainStoreService.persistPlan` + Codex pre-review (R4) + approval card
- `dispatch_build` → `JOB_DISPATCHER` (gated: only after operator approval)

The session uses **custom plan mode** — the system prompt instructs the model to call `submit_plan` instead of the SDK's native `ExitPlanMode`. Two-level planning is preserved: `submit_plan` persists a detailed decision record + section specs; per-section JIT `planSection` in the driver is unchanged.

**Intake split** (`brain/stimulus-router.service.ts`) — `StimulusRouter` is bound as `STIMULUS_CONSUMER`. Chat → `AgentSessionManager`; events → `EventTriageService` (verbatim extract of the old event triage path; behavior unchanged). The security gate (always-ask classifier on untrusted events) is untouched.

**Tool bridge** (`engine/tool-bridge-host.ts`, R1) — bidirectional NDJSON frame protocol over docker exec or local subprocess stdio. In-container entrypoint emits `{t:'tool_request', id, name, args}`; host answers with `{t:'tool_response', id, result}` or `{t:'tool_error', id, message}`. All tool requests are **scoped to the owning thread** (a `threadId` field in args must match — cross-thread requests denied). `LocalToolBridgeRunner` provides offline/CI operation without Docker.

**Per-thread sandbox lifecycle** (`driver/thread-lifecycle.service.ts`, R2) — explicit `createThread` control path: operator picks base branch → provision sandbox on base branch → `atlas_thread_sandboxes` row (lifecycle: `provisioning → ready`). On approval: `branchSwitch` cuts the feature branch in-place → lifecycle `branched`. Build phases reuse the same sandbox. The inbound-derived chat path still works (falls back to the old per-feature worktree path when no sandbox row exists — backward-compatible).

**Codex plan pre-review** (`brain/plan-review.service.ts`, R4) — on first `submit_plan` for a job: runs ONE Codex turn in the thread's sandbox (read-only; `mode: 'review'`), parses `FINDING:` lines, relays back into the Claude session for one revision. Second call for the same job: one-pass guard fires → returns `null` → straight to approval card. Uses `ENGINE_RUNNER` (the sandboxed runner when in docker mode). Best-effort: Codex failure is logged + treated as no findings (never blocks the build).

**Host-git policy** (`git/local-git.service.ts`) — all git invocations run with `core.hooksPath=/dev/null`, `core.fsmonitor=false`, LFS filters disabled (`filter.lfs.clean=`, `.smudge=`, `.process=`, `.required=false`), and `GIT_CONFIG_NOSYSTEM=1`. Flags are prepended unconditionally in the private `git()` method — no caller can accidentally omit them.

### 10.2 Multi-tenancy invariant

The invariant: **the host runs no tenant agent turns and no tenant-controlled code**. Brain and build turns execute in-sandbox. The GitHub token never enters the sandbox (git/PR stay host-side). Host git runs with hooks/filters disabled. Two concurrent threads get two isolated sandboxes on separate networks; neither can invoke the other's tools (enforced by `ToolBridgeHost` thread-scope check).

Verified by `r6-invariants.spec.ts` (20 tests, no I/O):
- `(a)` host-git safety flags present in `LocalGitService` source
- `(b)` `ScopingInvestigatorService` deleted; `EngineRunner` (host) not imported directly in `brain/` or `driver/` or `runner/`
- `(c)` cross-thread scope denial covered in `sandbox/tool-bridge.spec.ts` (R1 gate: subprocess-based live transport test)
- `(d)` web control endpoints flag-gated and guard `NotFoundException` on `ATLAS_SURFACE != 'web'`

### 10.3 New env vars

| Var | Default | Effect |
|---|---|---|
| `ATLAS_SURFACE` | `slack` | `web` = SSE+REST web surface; `agent` = in-process test surface; `slack` = Slack adapter (dormant) |

No new env vars beyond `ATLAS_SURFACE` (already existed; `web` value is new). All others (surface/sandbox/git) were already in `validation.ts`.

### 10.4 Commands

```
# Web surface dev run:
ATLAS_SURFACE=web pnpm -C backend atlas:dev

# Offline e2e (agent surface — unchanged, no Docker needed):
pnpm -C backend vitest run src/atlas/e2e

# R6 invariant tests:
pnpm -C backend vitest run src/atlas/r6-invariants.spec.ts

# Full atlas suite:
pnpm -C backend vitest run src/atlas    # 332+ tests green
```

### 10.5 Deferred (core spine first)

Mid-build steering ops: user-initiated pause/interject-into-phase/revert-phase/revise-plan + park-durability across restart. The read+submit+dispatch core (the 6 tools + the approval flow + the build) is proven first; these layer on after.

Also deferred: operator authn on the web control endpoints (`// TODO: authn` in `WebSurfaceController`) — currently any caller who can reach the HTTP port can post messages or rule on approvals.
