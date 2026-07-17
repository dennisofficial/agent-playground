# backend/CLAUDE.md — Atlas v2 backend deep-reference

Loads automatically when Atlas reads any file under `backend/`. Holds the backend-specific detail kept out
of the slim root `CLAUDE.md` (which carries the "you are Atlas" framing, repo layout, and product model).
**Canonical architecture doc:** `backend/src/app/ARCHITECTURE.md` — read it first when resuming Atlas work.

## Atlas modules (`backend/src/app/`)

Composed by `app/app.module.ts` (inside `AppModule`). One Nest module per domain.

| Module | Role |
|---|---|
| `persistence/` | The `atlas` datasource (`DB_CONNECTION`) + every `app` entity (`entities/index.ts` → `ENTITIES`). `synchronize: false`. |
| `auth/` | Email/password `/auth/*` (`@workspace/auth`, argon2, httpOnly JWT cookies). Global `AuthGuard`. |
| `org/` | `Organization` + membership; `OrgMembershipGuard` + `@CurrentOrg` (cross-tenant isolation); `OrgController`. `@Global`. |
| `onboarding/` | Per-org encrypted credentials (`OrgCredentialsEntity`, AES-256-GCM via `secret-cipher`), `CredentialResolver` (env-fallback), `connectRepo` + validated checklist + `tryActivate`; credentials/repo/onboarding controllers. `@Global`. |
| `surface/` | The web `CHAT_SURFACE` (`WebSurface`, SSE+REST) + `WebSurfaceController` (the org/repo/job API). `agent-surface/` is the in-process test surface. `SURFACE=agent` swaps it. |
| `stimulus/` | Intake seam: the chat bridge (`CHAT_SURFACE.inbound$` → resolves the job/thread by real id) + event firehose guards (dedup/rate-limit, repo routing, untrusted fence) + **route-or-drop** intake (`StimulusIntake.intakeEvent` routes a work-event to the owning job's live thread, else drops — never seeds). See `ARCHITECTURE.md` §12. |
| `ingress/` | HTTP edge for GitHub webhooks: the two front doors (`/webhooks/github/events` work-events + `/webhooks/github/state` state facts; `GithubNotificationSource` adapters) → **route to the owning job by PR/branch correlation, else drop (route-only, d6)** — repo activity NEVER seeds a job; `pull_request` events instead drive the silent PR-state sync. See the layered GitHub-sync model in `ARCHITECTURE.md` §12. |
| `brain/` | The **per-thread chat-session runner** (`AgentSessionManager`) for the session-backed conversational roles (`planner`/`post_build`/`ship`): each is its OWN fresh Claude Code session on the job's worktree (`handleChatTurn`/`deliverEvent`) — there is **no persistent job-wide "brain"** anymore, just one session per thread. Also holds the plan-approval gate (`DecisionApprovalService`), plan review (`PlanReviewService`), and the brain store (`BrainStoreService`). The shared per-thread session-turn primitive (`halt_reason` lifecycle) both this and the driver route through is `engine/thread-session-runner.service.ts`. NOTE: the module + class keep the legacy "brain" name; treat it as a per-thread session runner. See `ARCHITECTURE.md` §4, §6. |
| `driver/` | The **host scheduler** — `ThreadDriver` (`thread-driver.service.ts`) + `DriverStoreService`: a deterministic, resumable pipeline walker (legible loop, NOT an implicit FSM) that appends/opens thread groups & threads, seeds each thread's fresh session, advances `jobs.focused_thread_id` + derives `jobs.status`, drives the `section`/`master_review` execute turns, and runs the two product gates. **No brain-wake, no relays, no auto-resume sweeps** (all deleted). Plus `JobLifecycleService` (durable worktree/branch + disposable container; `createJob`/`closeJob`) and the GitHub PR-state reconciler. |
| `thread-group-kind/` | Declarative registry (`THREAD_GROUP_KIND_SPECS`) of thread-group behavior — `planning\|section\|master_review\|post_build\|ship` — boot-validated; adding a thread-group kind is one entry, not a new table. |
| `thread-kind/` | Declarative registry (`THREAD_KIND_SPECS`) of per-role thread behavior (engine, execution mode, verification gates, the per-role `operatorInput` toggle). |
| `decision-gate/` | Always-ask decision classification + park-and-ask (doubles as a security control for untrusted events). |
| `sandbox/` | Engine turns run `local` (git worktree) or `docker` (per-job container) behind `SANDBOX_PROVIDER`/`ENGINE_RUNNER` (`SANDBOX_MODE`). |
| `engine/` · `runner/` · `git/` | Claude/Codex invocation (plan/review/execute, isolated agent home), the turn runner, host-side git/PR. |
| `memory/` | Postgres pgvector semantic memory. |
| `autofix/` | The post-build auto-fix stage. |
| `test-bridge/` | DEV/TEST-only `POST /test/*` (404 unless `TEST_BRIDGE=on`) for driving Atlas headless. |

## Conventions that matter here

- **Migrations — NEVER hand-write.** The Atlas datasource has its OWN CLI (`cli/data-source.ts`, `migrations` table). Reshape entities, then `pnpm db:migration:generate <Name>` against live Postgres, prune generator noise, then `pnpm db:migrate`. The CLI loads entities from `src` via ts-node (no `shared/` rebuild needed). The generator does NOT emit `CREATE EXTENSION` (uuid-ossp, vector) or the pgvector HNSW index — hand-add those to the generated `up()` (see the current `InitAtlasSchema`). For a greenfield reset: `DROP SCHEMA public CASCADE; CREATE SCHEMA public`, delete `migrations/*`, regenerate, re-add the extensions+HNSW, migrate.
- **Tests:** `*.spec.ts` unit, `*.int.test.ts` integration (Postgres via `docker compose up -d postgres`, a DEDICATED `atlas_test` DB auto-created + migrated by `vitest.global-setup.ts`; `vitest.setup.ts` hard-refuses any non-`*_test` `POSTGRES_DB` because int tests TRUNCATE; `.env.test.enc` is authoritative in test runs), `*.ai.test.ts` real-LLM (`pnpm test:ai`). `pnpm test` runs unit + integration; `pnpm test:unit` is unit-only. Tests are excluded from the build tsconfig (`src/app/tsconfig.json`).
- **Env:** dotenvx — `.env.local.enc` (committed, encrypted, shared dev config) overlaid by `.env.personal` (personal, gitignored, `-o` wins). The `env:inject` script decrypts both for any command; `@nestjs/config` allows unknown keys (validation skipped entirely in test).
- **ESM-only deps** (`@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`) load via preserved dynamic `import()` (`module: nodenext`); LangChain is statically imported.
- Decorated discovery classes must be **plain class providers** (DiscoveryService can't see `useFactory`); registries fail boot loudly on misconfiguration.
