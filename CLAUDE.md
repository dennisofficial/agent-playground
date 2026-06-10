# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repo layout

Two implementations of the same autonomous-AI-employee system coexist:

- **`backend/` — the NestJS harness (CURRENT, actively developed).** The playground's logic recreated as per-domain Nest modules under `backend/src/harness/`, with Postgres durability. Composed by the `tui` app (`pnpm tui:dev` in `backend/`); the `api` app stays a skeleton until the Slack adapter pass.
- **`playground/` — the original terminal POC (WORKING, kept intact).** Single-process Ink TUI, in-memory channel, SQLite memory. **Do not modify or delete** — it's the reference implementation until the backend reaches feel-parity. Run with `pnpm dev` in `playground/`.

Also: `shared/` (`@workspace/shared` — TypeORM entities under `./schemas` subpath), `web/` (Next.js admin skeleton), `packages/nestjs-core-essentials` (house Nest conventions: `@CreateModule`, `BaseEnvService`).

## Backend harness (`backend/src/harness/`)

One Nest module per domain, all composed by `harness.module.ts` (import that one module to host the harness). **Only ONE process may compose it at a time** (no multi-conductor locking).

| Module | Role |
|---|---|
| `conductor/` | Event loop (`ConductorService`, lifecycle-hooked), per-bot LangGraph turn graphs (`BotGraphFactory`), RxJS event/status bus (`ConductorEventsBus`) — the presentation seam |
| `channel/` | The conversation log. **Synchronous in-memory face, write-behind Postgres durability** (`channel_messages` + `bot_cursors`); hydrates on boot. The sync `append`/`since` contract is load-bearing (mid-thought collaboration) |
| `employees/` | `@AIEmployee()` decorator + DiscoveryService auto-discovery. One class per teammate in `roster/` (persona, engine, tool allowlist); `EmployeeRegistry` validates at boot; `PersonaService` assembles prompts |
| `tools/` | `@HarnessTool()` decorator classes → `ToolRegistry`. Employee allowlists are **class references** (the class is the DI token), never name strings. `terminal: true` on a tool ends the turn |
| `engines/` | `claude`/`codex`/`langgraph` behind the `WorkerEngine` port. ESM-only SDKs arrive via `_lib/esm` DI tokens |
| `sessions/` | Employee-managed background sessions (long-lived interactive engine conversations — the bots' "Claude Code"). In-memory `SessionRegistry` behind `SESSION_REGISTRY`; `SessionRunnerService` runs one turn at a time inside the session's worktree; every turn-end relays to the owner, who replies (`reply_session`, mode-switchable per turn — 'plan' = engine-native read-only, 'execute' = writes) or closes (`close_session` → worklog) |
| `worktrees/` | Employee-managed git worktrees (`WorktreeService`), PER PROJECT: registered projects get their GitHub repo cloned on first use to `<REPOS_ROOT>/<projectId>`, unregistered fall back to `WORKER_ROOT`. Checkouts at `<repoRoot>/.worktrees/<id>-<slug>`; git is the durable store (re-adopted on boot from every known repo; shared association in `branch.<b>.agent-shared` config), mutating git ops mutex-serialized. Multi-employee features converge on a `shared/<slug>` integration branch (never checked out): personal branches cut from it, `publish`/`pull` merge through it (conflicts left in-progress for a session to resolve), and publish also pushes shared→origin behind a repo-identity guard. `open_pr` opens/finds the GitHub PR Dennis reviews |
| `projects/` | SLIM registry module (composable by the api app WITHOUT the harness): `projects` table (project id → GitHub repo/base branch/token ref) + `github_tokens` (named tokens, AES-256-GCM at rest via `SECRETS_ENCRYPTION_KEY`, write-only — `resolve()` is the single decrypt path), `GithubApiService` (fetch-based PR client), git auth via per-invocation `GIT_CONFIG_*` env (token never in argv/.git/config). Configured via the api app's admin REST (`/projects`, `/tokens`), gated by `ADMIN_API_TOKEN` bearer (disabled when unset) |
| `memory/` | Postgres semantic memory (pgvector facts + dedup judge), reminders (`TaskStore`), worklog, fetch/reconcile passes, and the LangGraph **Postgres checkpointer** (`CHECKPOINTER` token) |
| `gate/` | Respond/acknowledge/ignore: hard addressing rules + soft Haiku classifier |
| `surface/` | `CHAT_SURFACE` port (group-chat semantics: post/react/inbound$). Hosting app binds an adapter via a `@Global` module (see `tui/tui-surface.module.ts`); `SurfaceBridge` wires it to the conductor. No binding → headless |
| `skills/` | Typed scaffold only (`SkillSource` git/local + MCP config slots); loader is a no-op |
| `llm/` | `ChatModelFactory` (chat/gate/extract model builders, env-driven) + cost helpers |

Deliberately NOT ported (playground-only): ticket board, `/standup`-style commands. The playground's plan→approve→execute flow is SUPERSEDED in the backend by per-turn session modes (the employee approves a plan by replying with mode 'execute').

### Conventions that matter here

- Decorated classes (employees, tools) must be **plain class providers** — discovery can't see `useFactory` providers. Registries fail boot loudly on misconfiguration.
- `roleContext`/`personality` must be **byte-stable string constants** (prompt-cache `cache_control` breakpoints — no interpolation or getters).
- ESM-only deps (`@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`, `ink`, `@inkjs/ui`) load via preserved dynamic `import()` (`module: nodenext`); everything LangChain is dual-published and statically imported. The TUI's Ink shim is `src/tui/ink.ts` — `await loadInk()` before rendering, and never destructure its exports in CJS.
- Tests: `*.spec.ts` unit, `*.int.test.ts` integration (live Postgres via `docker compose up -d postgres`), `*.ai.test.ts` real-LLM (only `pnpm test:ai`). Migrations: NEVER hand-write — rebuild `shared/` first (the CLI loads entities from `dist/`), then `pnpm db:migration:generate <Name>` against the live Postgres, prune generator noise (it tries to drop the pgvector HNSW index and recreate partial indexes), then `pnpm db:migrate`.

## Playground (`playground/src/`) — reference implementation

- **Chat layer** (`src/bot-graph.ts`) — LangGraph state machine: gate → fetch context → LLM ⇄ tools → reconcile memory. Dispatches jobs but never blocks on them.
- **Job runner** (`src/jobs.ts` + `src/worker.ts`) — fire-and-forget background async; in-memory registry.
- **Worker engines** (`src/engines/`) — same three engines, selected per employee.
- **Memory** (`src/memory/`) — SQLite (`./.data/zero.db` + `checkpoints.db`); fetch pre-LLM, reconcile post-LLM on every gate path.
- Thread IDs: `${bot.id}:{project}:root`; the multi-surface `{botId}:{channelId}:{thread_ts}` convention in `playground/ARCHITECTURE.md` is the planned Slack design.
