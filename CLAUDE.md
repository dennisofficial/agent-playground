# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repo layout

Two implementations of the same autonomous-AI-employee system coexist:

- **`backend/` — the NestJS harness (CURRENT, actively developed).** The playground's logic recreated as per-domain Nest modules under `backend/src/harness/`, with Postgres durability. Two apps compose it: **`slack-app`** (`pnpm slack:dev`) is THE server — the harness headless with the Slack surface + ingress bound, single-process multi-tenant (the Slack adapter has SHIPPED — `slack-app/slack-chat-surface.ts`, incl. message + reaction support); **`api`** is the standalone admin REST (projects/tokens/skill grants), composable WITHOUT the harness.
- **`playground/` — the original terminal POC (WORKING, kept intact).** Single-process Ink TUI, in-memory channel, SQLite memory. **Do not modify or delete** — it's the reference implementation until the backend reaches feel-parity. Run with `pnpm dev` in `playground/`.

Also: `shared/` (`@workspace/shared` — TypeORM entities under `./schemas` subpath), `packages/nestjs-core-essentials` (house Nest conventions: `@CreateModule`, `BaseEnvService`).

**Submodule prerequisite:** `packages/nestjs-ai-essentials` (`@workspace/langfuse`) and `packages/jwt-auth` (`@workspace/auth`) are git submodules — run `pnpm run setup` from repo root (submodule init + install + package builds), otherwise TS2307 "Cannot find module '@workspace/langfuse'" / '@workspace/auth' at test/typecheck time.

## Backend harness (`backend/src/harness/`)

One Nest module per domain, all composed by `harness.module.ts` (import that one module to host the harness). **Only ONE process may compose it at a time** (no multi-conductor locking).

| Module | Role |
|---|---|
| `conductor/` | Event loop (`ConductorService`, lifecycle-hooked), per-bot LangGraph turn graphs (`BotGraphFactory`), RxJS event/status bus (`ConductorEventsBus`) — the presentation seam |
| `channel/` | The conversation log. **Synchronous in-memory face, write-behind Postgres durability** (`channel_messages` + `bot_cursors`); hydrates on boot. The sync `append`/`since` contract is load-bearing (mid-thought collaboration) |
| `employees/` | `@AIEmployee()` decorator + DiscoveryService auto-discovery. One class per teammate in `roster/` (persona, engine, tool allowlist); `EmployeeRegistry` validates at boot; `PersonaService` assembles prompts |
| `tools/` | `@HarnessTool()` decorator classes → `ToolRegistry`. Employee allowlists are **class references** (the class is the DI token), never name strings. No tool ends the turn directly — every tool batch loops back to the model, and a turn ends only when the bot's next step makes no tool call |
| `engines/` | `claude`/`codex`/`langgraph` behind the `WorkerEngine` port. ESM-only SDKs arrive via `_lib/esm` DI tokens |
| `sessions/` | Employee-managed background sessions (long-lived interactive engine conversations — the bots' "Claude Code"). In-memory `SessionRegistry` behind `SESSION_REGISTRY`; `SessionRunnerService` runs one turn at a time inside the session's worktree; every turn-end relays to the owner, who replies (`reply_session`, mode-switchable per turn — 'plan' = engine-native read-only, 'execute' = writes) or closes (`close_session` → worklog) |
| `worktrees/` | Employee-managed git worktrees (`WorktreeService`), PER PROJECT: registered projects get their GitHub repo cloned on first use to `<REPOS_ROOT>/<projectId>`, unregistered fall back to `WORKER_ROOT`. Checkouts at `<repoRoot>/.worktrees/<id>-<slug>`; git is the durable store (re-adopted on boot from every known repo; shared association in `branch.<b>.agent-shared` config), mutating git ops mutex-serialized. Multi-employee features converge on a `shared/<slug>` integration branch (never checked out): personal branches cut from it, `publish`/`pull` merge through it (conflicts left in-progress for a session to resolve), and publish also pushes shared→origin behind a repo-identity guard. `open_pr` opens/finds the GitHub PR Dennis reviews |
| `projects/` | SLIM registry module (composable by the api app WITHOUT the harness): `projects` table (project id → GitHub repo/base branch/token ref) + `github_tokens` (named tokens, AES-256-GCM at rest via `SECRETS_ENCRYPTION_KEY`, write-only — `resolve()` is the single decrypt path), `GithubApiService` (fetch-based PR client), git auth via per-invocation `GIT_CONFIG_*` env (token never in argv/.git/config). Configured via the api app's admin REST (`/projects`, `/tokens`), gated by `ADMIN_API_TOKEN` bearer (disabled when unset) |
| `memory/` | Postgres semantic memory (pgvector facts + dedup judge), reminders (`TaskStore`), the shared **team board** (`BoardStore` — claimable tasks with assignees + dependencies; atomic claim via conditional UPDATE), worklog, fetch/reconcile passes, and the LangGraph **Postgres checkpointer** (`CHECKPOINTER` token) |
| `gate/` | Respond/acknowledge/ignore: hard addressing rules + soft Haiku classifier |
| `surface/` | `CHAT_SURFACE` port (group-chat semantics: post/react/inbound$). Hosting app binds an adapter via a `@Global` module — `slack-app/slack-surface.module.ts` (the shipped Slack adapter: real `chat.postMessage` + `reactions.add/remove`, unicode→shortcode mapped in `slack-app/slack-text.ts`). `SurfaceBridge` wires it to the conductor. No binding → headless |
| `skills/` | Skills + MCP loader/booter. `SkillLoaderService` resolves `SkillSource` (git clone/cache + local, repo-root-relative) → SKILL.md; `EngineHomeProvisioner` materializes each employee's per-engine home as an EXACT MIRROR (Claude: symlinks + `skills`/`mcpServers` options; Codex: `config.toml` + `AGENTS.md` preamble; LangGraph: prompt listing + `@langchain/mcp-adapters` tools). Sources = code-declared (`employee.skills`/`mcpServers`) ∪ DB grants (`employee_skills`/`employee_mcp_servers`, via `employee-skills/` stores), deduped by name; a DB trigger `NOTIFY`s and `GrantChangeListener` reactively reconciles the affected employee (no restart, no poll). Control via admin REST (`/admin/employees/:id/skills|mcp`) or the `db:seed` seeder |
| `llm/` | `ChatModelFactory` (chat/gate/extract model builders, env-driven) + cost helpers |

Deliberately NOT ported (playground-only): `/standup`-style commands. The playground's ticket board is SUPERSEDED by the team board (`BoardStore` + `*_board_task` tools — Atlas, the team lead, owns it), and its plan→approve→execute flow by per-turn session modes (the employee approves a plan by replying with mode 'execute').

### Conventions that matter here

- Decorated classes (employees, tools) must be **plain class providers** — discovery can't see `useFactory` providers. Registries fail boot loudly on misconfiguration.
- `roleContext`/`personality` must be **byte-stable string constants** (prompt-cache `cache_control` breakpoints — no interpolation or getters).
- ESM-only deps (`@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`) load via preserved dynamic `import()` (`module: nodenext`); everything LangChain is dual-published and statically imported.
- Tests: `*.spec.ts` unit, `*.int.test.ts` integration (Postgres via `docker compose up -d postgres`, but a DEDICATED `agent_playground_test` database — auto-created + migrated by `vitest.global-setup.ts`; `vitest.setup.ts` hard-refuses any non-`*_test` `POSTGRES_DB` because int tests TRUNCATE tables, and `.env.test.enc` is authoritative over `.env.personal` in test runs), `*.ai.test.ts` real-LLM (only `pnpm test:ai`). Migrations: NEVER hand-write — rebuild `shared/` first (the CLI loads entities from `dist/`), then `pnpm db:migration:generate <Name>` against the live Postgres, prune generator noise (it tries to drop the pgvector HNSW index and recreate partial indexes), then `pnpm db:migrate`.

## Playground (`playground/src/`) — reference implementation

- **Chat layer** (`src/bot-graph.ts`) — LangGraph state machine: gate → fetch context → LLM ⇄ tools → reconcile memory. Dispatches jobs but never blocks on them.
- **Job runner** (`src/jobs.ts` + `src/worker.ts`) — fire-and-forget background async; in-memory registry.
- **Worker engines** (`src/engines/`) — same three engines, selected per employee.
- **Memory** (`src/memory/`) — SQLite (`./.data/zero.db` + `checkpoints.db`); fetch pre-LLM, reconcile post-LLM on every gate path.
- Thread IDs: `${bot.id}:{project}:root`; current Slack/TUI surface architecture is documented in `playground/ARCHITECTURE.md`.
