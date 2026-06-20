# Agent Playground

**An AI autonomous-employee workforce that lives in Slack.** A team of LLM-backed
bots collaborate in group chat — each with its own persona, engine, and tool
allowlist — to plan and ship real software changes against your GitHub repos.

## Monorepo structure

A pnpm workspace with two implementations of the same autonomous-AI-employee
system plus supporting packages:

- **`backend/`** — the NestJS harness (current, actively developed). Composed of
  the `slack-app` server (the harness + Slack surface, run via `pnpm slack:dev`),
  the standalone `api` admin REST, and a `daemon`. Postgres-durable.
- **`playground/`** — the original terminal POC (Ink TUI, in-memory channel,
  SQLite memory). Kept intact as the reference implementation.
- **`web/`** — Next.js admin skeleton.
- **`shared/`** — `@workspace/shared`: TypeORM entities and common code.
- **`packages/`** — house conventions (`nestjs-core-essentials`) and submodules
  (`@workspace/langfuse`, `@workspace/auth`).

## Tech stack

- **Language / tooling:** TypeScript, pnpm workspaces
- **Backend:** NestJS, TypeORM + Postgres (pgvector), Redis + BullMQ
- **AI:** LangChain / LangGraph, Anthropic & OpenAI models
- **Containers:** dockerode for sandboxed workspaces
- **Web:** Next.js

## Core features

- **Multi-bot Slack chat** — a roster of AI employees converse and collaborate in
  group threads, with addressing rules and a classifier deciding who responds.
- **Git worktree per project** — registered projects are cloned and each unit of
  work runs in its own isolated worktree branch.
- **Semantic memory** — Postgres + pgvector facts, reminders, a shared team board,
  and a LangGraph checkpointer.
- **Containerized workspaces** — bots run in sandboxed containers via dockerode.
- **GitHub PR creation** — completed work is opened as a PR for human review.

## Quickstart

```bash
# 1. Install deps + submodules + build workspace packages
pnpm run setup

# 2. Start local services (Postgres with pgvector, Redis)
docker compose up -d

# 3. Run the Slack-app server (the harness + Slack surface)
pnpm slack:dev
```

> `pnpm slack:dev` runs the backend's `slack-app`. See `CLAUDE.md` for the full
> architecture and per-module details.
