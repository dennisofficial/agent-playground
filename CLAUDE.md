# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repo layout

**Atlas v2 is the sole system.** The v1 harness, the `slack-app`/`api`/`daemon` apps, and the `playground/` TUI POC were all deleted (06-20). One backend app remains.

- **`backend/` — the Atlas v2 NestJS app (the whole system).** A single HTTP app: `src/app-main.ts` boots `AppModule` on `:4002` over its OWN named Postgres connection (`atlas`, `app` schema, `migrations` table). Run `pnpm dev` (ts) or `pnpm build && node dist/main` (built). All domain code is under `backend/src/app/`.
- **`web/` — the Next.js operator console.** Talks to the backend DIRECTLY (no proxy) at `NEXT_PUBLIC_HTTP_URL` (`:4002`) with credentialed CORS: `/auth/*` + `/web/*`. (NOTE: as of the org/repo/thread rebuild the web app still calls some removed endpoints — it needs rewiring to the `/web/orgs/:orgId/...` API; see `atlas-org-repo-thread-rebuild` memory.)
- `shared/` (`@workspace/shared` — base TypeORM entities like `TimestampedEntity` under `./schemas`), `packages/*`, `docs/`, `prompts/`, `assets/`. (The repo-root `skills/` POC folder is gone — its keepers now live as Atlas system-tier skills under `backend/skills-managed/` (static) and `system-skill-registry.ts`'s git-sourced entries (synced from upstream); the rest were dev-machine-only Claude Code skills, unrelated to the product.)

**Canonical architecture doc:** `backend/src/app/ARCHITECTURE.md` — the job/session model (the job brain vs build sessions, event intake, known divergences). **Read it first** when resuming Atlas work — it is REWRITTEN to the current vocabulary (Job = container, Thread = build lane, Step = leaf). `backend/src/app/ATLAS_V2.md` is kept for deeper detail + build history but uses the OLD vocabulary (thread=container, track/section=lane, phase=step) AND predates the org→repo→job rebuild — treat it as history, not truth.

**Submodule prerequisite:** `packages/jwt-auth` (`@workspace/auth`), `packages/nestjs-ai-essentials` (`@workspace/langfuse`), and `packages/nestjs-core-essentials` (`@workspace/nestjs-core` — `@CreateModule`, `BaseEnvService`) are git submodules — run `pnpm run setup` from repo root (submodule init + install + package builds), otherwise TS2307 "Cannot find module '@workspace/…'" at test/typecheck time. In the Atlas sandbox, submodule-bearing repos like this one are provisioned as full clones rather than linked worktrees, so submodule packages build without cross-device (`EXDEV`) link errors (see `docs/adr/0006-clone-provisioning-for-submodule-repos.md`).

**Sandbox test repo:** `github.com/dennisofficial/test-repo` is the **throwaway sandbox repo** the dev environment connects for exercising the build/rotation pipeline end-to-end. It is a REAL repo that exists purely so Atlas can push dirty/experimental commits and open junk PRs against it **with no repercussions** — nothing there is precious (overwrite / force-push / junk-PR freely). It was seeded with an initial `main` commit (README + minimal `src/`) so `git fetch origin main` works; an empty repo (no `main` ref) makes sandbox workspace setup fail with `fatal: couldn't find remote ref main`.

## The product model — Organization → Users → Repos → Jobs (each with many Threads)

> **Deployment model: private, not SaaS.** Atlas is a personal/private tool for Dennis and a small circle of close friends — it is **not** sold or hosted as a commercial multi-tenant SaaS. The org/membership model below provides *private multi-workspace isolation between trusted friends*, not a hardened boundary for untrusted paying customers. Read "tenant" throughout as *private workspace*. Selling was ruled out because the only economical model (each user on their own Claude subscription) isn't allowed in a sold product, and API keys are too expensive to resell — see the `saas-credential-compliance` memory.

- An **Organization** (`organizations`) is the tenant; the `org_id` dimension scopes every `app` table.
- **Users** (`users`, email/password via `@workspace/auth`) join orgs through **`organization_members`** (owner/admin/member). Registration is OPEN and immediately usable (no approval gate).
- A **Repo** (`repos`, composite PK `(org_id, repo_id-slug)`) is a connected GitHub repo — the conversation container (the old 1:1 `channels` is gone).
- A **Job** (`jobs`, real uuid id) is a conversation/work unit on a repo (owns the branch + sandbox + PR + one `messages` log). A Job has many **Threads** (`threads`) — its build lanes (a Main planning lane + one per build track). NOTE: the DB table for the container is `jobs`; the lane table is `threads` (formerly `tracks`).
- **Onboarding:** create org → set per-org credentials (Anthropic key + engine auth + GitHub PAT, validated) → connect a repo (GitHub access validated → `access_ok`) → org flips to `active` → jobs can be created.
- **Web API:** `/auth/*` (login/register/session-with-orgs) + `/web/orgs/:orgId/...` gated by the global `AuthGuard` (cookie) AND `OrgMembershipGuard` (`@CurrentOrg`). Job CRUD lives under `/web/orgs/:orgId/repos/:repoId/jobs…` (create/list/say/SSE events/messages/approve/pipeline/DELETE).

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
| `driver/` | The deterministic, resumable thread/step build driver (legible loop, NOT an implicit FSM) + `JobLifecycleService` (durable worktree/branch/session + disposable container; `createJob`/`closeJob`). |
| `decision-gate/` | Always-ask decision classification + park-and-ask (doubles as a security control for untrusted events). |
| `sandbox/` | Engine turns run `local` (git worktree) or `docker` (per-job container) behind `SANDBOX_PROVIDER`/`ENGINE_RUNNER` (`SANDBOX_MODE`). |
| `engine/` · `runner/` · `git/` | Claude/Codex invocation (plan/review/execute, isolated agent home), the turn runner, host-side git/PR. |
| `memory/` | Postgres pgvector semantic memory. |
| `autofix/` | The post-build auto-fix stage. |
| `test-bridge/` | DEV/TEST-only `POST /test/*` (404 unless `TEST_BRIDGE=on`) for driving Atlas headless. |

## Conventions that matter here

- **Migrations — NEVER hand-write.** The Atlas datasource has its OWN CLI (`cli/data-source.ts`, `migrations` table). Reshape entities, then `pnpm db:migration:generate <Name>` against live Postgres, prune generator noise, then `pnpm db:migrate`. The CLI loads entities from `src` via ts-node (no `shared/` rebuild needed). The generator does NOT emit `CREATE EXTENSION` (uuid-ossp, vector) or the pgvector HNSW index — hand-add those to the generated `up()` (see the current `InitAtlasSchema`). For a greenfield reset: `DROP SCHEMA public CASCADE; CREATE SCHEMA public`, delete `migrations/*`, regenerate, re-add the extensions+HNSW, migrate.
- **Tests:** `*.spec.ts` unit, `*.int.test.ts` integration (Postgres via `docker compose up -d postgres`, a DEDICATED `agent_playground_test` DB auto-created + migrated by `vitest.global-setup.ts`; `vitest.setup.ts` hard-refuses any non-`*_test` `POSTGRES_DB` because int tests TRUNCATE; `.env.test.enc` is authoritative in test runs), `*.ai.test.ts` real-LLM (`pnpm test:ai`). `pnpm test` runs unit + integration; `pnpm test:unit` is unit-only. Tests are excluded from the build tsconfig (`src/app/tsconfig.json`).
- **Env:** dotenvx — `.env.local.enc` (committed, encrypted, shared dev config) overlaid by `.env.personal` (personal, gitignored, `-o` wins). The `env:inject` script decrypts both for any command; `@nestjs/config` allows unknown keys (validation skipped entirely in test).
- **ESM-only deps** (`@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`) load via preserved dynamic `import()` (`module: nodenext`); LangChain is statically imported.
- Decorated discovery classes must be **plain class providers** (DiscoveryService can't see `useFactory`); registries fail boot loudly on misconfiguration.
