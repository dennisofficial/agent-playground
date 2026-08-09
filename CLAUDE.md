# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Additional claude.md files exist in `tui/`, `backend/`, and `web/`.

## What this repo is right now

Atlas is an agent-orchestration harness. It exists in two forms, and **only one of them is
active**:

| Workspace               | Status                                | Notes                                                                                                    |
| ----------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `tui/`                  | **ACTIVE — this is the priority app** | `@dltech/atlas-harness`, a local terminal harness over the Claude/Codex agent SDKs. See `tui/CLAUDE.md`. |
| `backend/`              | **paused**                            | NestJS cloud harness. Reference/prior art only.                                                          |
| `web/`                  | **paused**                            | Next.js front end for the cloud harness. Reference/prior art only.                                       |
| `shared/`               | paused                                | `@workspace/shared` — DTOs/enums for backend+web. The TUI deliberately does **not** import it.           |
| `packages/codex-sdk`    | active dependency                     | `@workspace/codex-sdk` — typed Codex client. The TUI's only workspace dep.                               |
| `packages/agent-engine` | **do not use**                        | An engine abstraction that has never been run. Read as prior art; never import.                          |

Default assumption for any new work: it happens in `tui/`. Do not touch `backend/`, `web/`, or
`shared/` unless explicitly asked — changes there are unverified and unrunnable in practice.

`backend/src/**_old*` directories and `web/src/lib/api/` are legacy-by-designation: read for
reference, never extend.

## Design docs

The TUI's design is written down and is the source of truth over any inference from code:

- `docs/tui-wireframes.md` — every page and state, the message grammar, the v1 cut line
- `docs/tui-architecture.md` — layering, dependency rules, startup/migration, accounts/rotation
- `docs/tui-handoff.md` — why decisions were made, what was rejected, what is still unverified

These predate the OpenTUI/Bun migration in places (they say Ink, Node, `better-sqlite3`). Where a
doc and the code disagree about _mechanism_, the code wins; where they disagree about _intent_, ask.

## Code style

- **Max 300 lines per file.** Split into focused modules if exceeded.
- **No `as any` casts.** Use proper types, generics, or `unknown` with type guards.
- **No `@ts-ignore` / `@ts-expect-error`.** Fix the type instead.
- **Strict TypeScript.** `strict`, `noUncheckedIndexedAccess`, no implicit `any`.
- **Early returns** over nested conditionals.
- **Named parameters** for functions with 2+ arguments.
- **Event handlers** prefixed with `handle`.
- **`E`-prefixed real TS enums** for value unions (`EEngine`, `EThreadRole`), not const-tuple + type.
- **Comments explain _why_.** The existing code carries dense rationale comments on load-bearing
  decisions — match that density rather than stripping or padding it.

## Naming

- Tests live in a sibling `__tests__/` directory as `*.spec.ts(x)`.

## Testing

- **Every new feature includes tests.** TDD preferred.
- `tui/` runs `bun test`; `backend/` and `web/` run `vitest run` (paused, so rarely relevant).
- Pure logic goes in `domain/` precisely so it can be tested without a terminal or a container —
  when something is hard to test, that is usually the signal to move the decision into `domain/`.

## Git

- **Commit directly to `main`.** Never branch, never force-push, never `--no-verify`.
- **Never use `git stash`** unless explicitly asked.
- Conventional commits: `<type>(<scope>): <description>` — imperative, lowercase.
- No `Co-Authored-By` or "Generated with Claude" trailers.

## Workspace mechanics

**pnpm is the package manager everywhere.** pnpm 11 workspace (`pnpm-workspace.yaml`), Node 22.13
(`.nvmrc`), pinned via `packageManager` in the root `package.json`. Install and link with pnpm only
— never `bun install` / `npm install` / `yarn`.

- Run scripts as `pnpm --filter <pkg> <script>` from the root, or `pnpm run <script>` in the package.
- Native/postinstall builds must be allowlisted in `pnpm-workspace.yaml` → `allowBuilds`.
- `typescript` and `react` are pinned repo-wide via `overrides`; don't bump them in one package.
- `injectWorkspacePackages` + `nodeLinker: isolated` keep single instances of peer deps
  (`@nestjs/*`, `@langchain/core`, `react`). Changing either is a repo-wide decision.

**Bun is a runtime, not the package manager, and only `tui/` uses it.** The TUI's `dev` / `test` /
`build` scripts shell out to `bun` because OpenTUI's renderer is a Zig library reachable only
through Bun's FFI. Dependencies still come from pnpm. Nothing outside `tui/` runs on Bun — don't
introduce `bun:*` imports or `bun test` into `backend/`, `web/`, `shared/`, or `packages/`.
