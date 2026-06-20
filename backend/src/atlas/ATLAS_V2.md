# Atlas v2 — canonical reference

> Single source of truth for the clean-room orchestrator in `backend/src/atlas/`. Written 2026-06-20 after the overnight W0–W9 build. Read this first when resuming Atlas work (esp. the Docker sandbox rework). Full design history: `/Users/dennis/.claude/plans/this-ai-orchestrator-is-greedy-parnas.md`.

## 1. Why this exists

v1 (`backend/src/harness/`) had already collapsed to one chat employee (Atlas) + non-chat phase roles and already did section-driven JIT planning / one-branch / one-PR. The disease was *how* it was built: `pipeline-runner.service.ts` (1,849 LOC) was an **implicit FSM** re-entered via `status` enums across 5 tables on racing async signals; execution was **daemon-only** (a 7,200-LOC Docker/daemon sandbox stack); the module graph was board-coupled throughout. Too fragile to evolve.

Atlas v2 re-implements the proven semantics **legibly and daemon-free**, in a **clean room with ZERO imports from v1** (`harness/**` or v1 `slack-app/**`). Anything wanted from v1 was copied/rewritten. v1 is still intact beside v2 (deletion = W8, intentionally **not done** — held for Dennis's review; it's irreversible and not needed to plan Docker).

**Goal:** automate Dennis's real workflow — chat → plan → Codex review → revise → approve → execute in sections/phases → self-review → one PR — AND react autonomously to notifications (alert → fix → PR). Dennis only reviews **system decisions + PRs**.

## 2. The locked design model

**Brain vs hands.** `Atlas = brain`: a small conversational/reactive decider (triage → ignore/ask/dispatch; grill → decision record + section list). The `pipeline = hands`: a plain deterministic `async` driver that walks a planner-emitted list — **legible top-to-bottom, NOT an implicit FSM**. Dynamism (count of sections/phases) is data the planner emits; control flow stays a readable loop. Explicit step-state rows exist only so `resume()` knows where to re-enter.

**Tenancy.** `Tenant` (Slack workspace = `team_id`) ⊃ `Projects` (GitHub repos) ⊃ `Channel` (**1:1 per project**) + per-feature **sandbox** (MVP: a local git worktree; Docker later — same abstraction). Channel-per-project: notifications route to the project's channel; collapses to one channel for single-repo tenants.

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

All build workstreams **W0–W7 DONE + integrated**; **W9 verification DONE**; **W8 (delete v1) HELD**. 187 atlas tests green, full graph boots against Postgres, zero v1 imports.

**Proven LIVE end-to-end:** the W1 gate (real engine turn → Slack thread → PR #44) AND a full chat-driven feature drive that opened **`dennisofficial/ai-crew#45`** (grill → approve → section "investigate" → section "write README" committed → 3-lens auto-fix found+fixed 2 issues → PR-tail → PR). `resume()` reconciles interrupted jobs (it correctly 422'd a stale empty-commit job on reboot). Offline e2e (fake LLM): all 3 scenarios pass deterministically.

**Bug found + fixed during W9:** mid-grill, a human follow-up was being **re-triaged and dropped** (continuity check looked for an open *job*, but none exists during the question phase). Fixed by anchoring a `scoping` job at triage time (`triage.service.ts`); regression-tested in `triage.service.spec.ts`.

## 7. OPEN tuning/design items (Dennis's to dial in — NOT architectural, orthogonal to Docker)

1. **Builds are slow** (~7 min for a trivial README change). The planner inserts an "investigate" section first and runs the 3-lens auto-fix on *every* section incl. zero-change ones. Many LLM turns for small work. Tuning: planner shouldn't over-decompose; skip auto-fix on 0-change sections; the e2e PR poll (now 420s in `e2e-harness.service.ts`) still missed PR #45 by ~6s.
2. **Autonomy/security triage is non-deterministic.** The real triage LLM sometimes PARKS an untrusted event (safe), sometimes summarizes it as a benign job and DISPATCHES (e2e runs 1-2 parked the injection; run 3 dispatched a benign "fix CI failure"). The injected **destructive action never executed**, but the triage-level guard isn't reliable — it relies on the driver's per-section gate as defense-in-depth. **RECOMMENDATION: move the autonomy gate out of triage** (which classifies an *unplanned* fix it can't verify) **into the driver's per-section gate** (where real decisions are known) — both more deterministic and the right layer. The classifier itself is deterministic on rules; the non-determinism is the triage LLM's event→summary step.
3. **e2e hygiene:** boot-time `resume()` re-attempts prior runs' stale jobs before the harness's `purgePriorRun` runs.
4. **Test artifacts on `ai-crew`:** draft PR #44 (gate), PR #45 (e2e feature), + stray `atlas/feature-*` / `atlas/bugfix-*` branches — safe to close.

Convention: Dennis tunes conversational/UX behavior himself; ship + flag, don't burn billed runs on subjective feel (`no-self-billed-behavior-validation` memory).

## 8. Docker sandbox rework — planning context (NEXT)

This is the deferred, separately-planned effort. Today execution is **host-only**: a per-feature "sandbox" is a **local git worktree** (`LocalGitService.createFeatureSandbox` at `<ATLAS_REPOS_ROOT>/<project>/.worktrees/atlas-<branch>`), and engine turns run on the host via `EngineRunner` with an isolated agent home. The Docker rework replaces *where* a turn + its git ops execute (inside a per-feature container) without changing the brain/driver.

- **The seam to containerize:** `driver/section-driver.service.ts` resolves a sandbox (worktree path) once per job, then `TurnRunnerService`/`EngineRunner` run turns with that `cwd`, and `LocalGitService`/`GithubPrService` do git/PR. A Docker version routes turn-execution + git into a container (cf. v1's `TurnExecutor.isContainerized()` local-vs-remote split — but rebuild simply).
- **Isolation unit = per feature** (one container per in-flight feature/branch; sections stack inside it; phases are fresh sessions sharing the checkout). Parallel features = separate containers.
- **v1's Docker stack to learn from but NOT import** (it's the fragile thing being replaced): `harness/workspaces/` (~7,200 LOC: `ContainerManagerService`, `WorkspaceProvisionerService`, `DaemonClient` over Redis, idle reaper, daemon version reconcile) + `harness/daemon/` (in-container NestJS, `DaemonGitService`, `DaemonTurnService`). Keep the redo **simple**.
- **Dennis's noted requirement (fold into this plan):** "a channel should have access to any other repo it wants, as references." See the `reference-shared-library` memory — a host-maintained READ-ONLY library, one clone per project (each with its own token), bind-mounted at `/refs` in every sandbox.
- **Engine creds + isolated home** already abstracted (`ATLAS_ENGINE_AUTH_MODE`, `ATLAS_AGENT_HOME_ROOT`) — carry into the container.

When planning Docker: use plan mode (Codex plan-review hook fires), reuse the `nestjs-di-over-facades` / `reuse-dont-reinvent` conventions, and keep the clean-room rule (Docker code lives in atlas, no v1 imports).
