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
| `stimulus/` | Intake seam: the chat bridge (`CHAT_SURFACE.inbound$` → `ChatStimulus`, resolves the job by real id) + event firehose guards (dedup/rate-limit, repo routing, untrusted fence, seed-job). The `Stimulus` union + router are slated for rework — see `ARCHITECTURE.md` §7. |
| `ingress/` | HTTP edge for notifications: `POST /ingress/github` + `/ingress/webhook` (`NotificationSource` adapters → **route to the owning job by PR/branch correlation, else seed a new job**; `pull_request` events instead drive the silent PR-state sync). See the layered GitHub-sync model in `ARCHITECTURE.md` §7. |
| `brain/` | The per-job in-sandbox Claude Code session (`AgentSessionManager`) = the **job brain** = the **main Claude Code session running in the job's sandbox** (what the operator talks to; its system prompt opens with *"You are Atlas"*): intent/grill → locked decision record → plan → steer; the approval gate (`DecisionApprovalService`); the untrusted-event triage lane (`EventTriageService`, slated for rework). No central "Atlas" persona — the job's own session is the only conversational agent it has. See `ARCHITECTURE.md` §1, §4. |
| `driver/` | The deterministic, resumable, **headless** thread-group/thread build driver (legible loop, NOT an implicit FSM; no more brain-wake on halt/done) + `JobLifecycleService` (durable worktree/branch/session + disposable container; `createJob`/`closeJob`). |
| `thread-group-kind/` | Declarative registry (`THREAD_GROUP_KIND_SPECS`) of thread-group behavior — `planning\|plan_review\|build\|direct_build\|master_review\|post_build\|ci` — boot-validated; adding a thread-group kind is one entry, not a new table. |
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
