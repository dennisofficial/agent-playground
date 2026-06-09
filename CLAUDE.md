# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

All commands run from `playground/` (the only workspace package).

| Command | Purpose |
|---|---|
| `pnpm dev` | Run CLI with hot-reload (tsx + dotenvx `.env.personal`) |
| `pnpm build` | Compile to `dist/` via tsup (ESM) |
| `pnpm start` | Run compiled build |
| `pnpm typecheck` | Type-check without emit — the primary correctness gate (no test suite) |
| `pnpm format` | Prettier + import organizer (`.prettierrc` wires `prettier-plugin-organize-imports`) |
| `pnpm consolidate-memory` | Compact the semantic fact store |

## Architecture

A terminal proof-of-concept for autonomous AI employees. Each "employee" (Alex, James, Sam — defined in `src/employees/`) has a chat identity, a background job runner, and persistent memory, all in a single Node.js process.

### Three layers per employee

- **Chat layer** (`src/bot-graph.ts`) — LangGraph state machine: gate → fetch context → LLM ⇄ tools → reconcile memory. Dispatches jobs but never blocks on them.
- **Job runner** (`src/jobs.ts` + `src/worker.ts`) — Fire-and-forget background async. Chat turns return immediately; the job runs to completion and notifies via `onJobUpdate`. **Job registry is in-memory** — jobs and progress vanish on restart.
- **Worker engines** (`src/engines/`) — Pluggable: `claude` (Anthropic Agent SDK), `codex` (OpenAI Codex SDK), `langgraph` (custom ReAct loop). Selected per employee via `Employee.engine`.

### Memory pipeline (per turn)

- **respond path:** `fetchContext()` injects relevant facts + open tasks → LLM call (may call `remember`/`update`/`forget` tools) → `reconcileMemory()` + `reconcileTasks()` extract and upsert from the exchange
- **ack/ignore path:** consume messages → `reconcileMemory()` + `reconcileTasks()` (no pre-LLM fetch; reconcile fires as backstop regardless)

Memory always updates even when the agent stays silent.

### Key files

| File | Role |
|---|---|
| `src/conductor.ts` | Event loop — manages per-bot cursors, schedules turns, owns the TUI |
| `src/bot-graph.ts` | LangGraph turn graph (gate → fetch → llm → tools → reconcile) |
| `src/employees/index.ts` | `ROSTER`, `Employee` type, addressing helpers |
| `src/engines/index.ts` | Engine registry, `defaultEngine()` |
| `src/memory/db.ts` | SQLite schema + `getDb()` factory |
| `src/memory/fetch.ts` | Pre-LLM context assembly |
| `src/memory/reconcile.ts` | Post-LLM fact/task extraction |

### Thread IDs and data

Current CLI hardcodes `${bot.id}:dev:root` as the LangGraph thread ID (see `conductor.ts:222`). The multi-surface `{botId}:{channelId}:{thread_ts}` convention in `playground/ARCHITECTURE.md` is the planned Slack adapter design, not yet implemented.

Data files live in `./.data/` (`src/memory/paths.ts`): `zero.db` (facts, tasks, worklog) and `checkpoints.db` (LangGraph message history).

---

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
