# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository.

## What this repo is

Atlas is a **coding-agent harness**. Not a wrapper around someone else's harness — the agentic
loop is ours. We make raw LLM calls through the Vercel AI SDK and own every decision the loop
makes: what context the model sees, which tools it may call, when a human is asked, what happens
on rewind.

Because we make raw model calls, Atlas is model-agnostic by construction. Claude and Codex
subscription credentials are one provider implementation among several, not a foundation.

Read `docs/architecture.md` before changing anything structural. It is the source of truth over
any inference from code, and `docs/core-contract.md` holds the seams it depends on.
`docs/research/` holds the primary-source investigation both were derived from.

## Package layout

| Package                      | Depends on     | Owns                                                          |
| ---------------------------- | -------------- | ------------------------------------------------------------- |
| `@dltech/atlas-core`         | `zod` only     | Events, IDs, context assembly, hook and port contracts. Pure.  |
| `@dltech/atlas-harness`      | core           | The loop, hooks, tools, model adapters, credentials, store.    |
| `@dltech/atlas` (`apps/tui`) | core, harness  | OpenTUI + React terminal app and the composition root.         |

Three packages, not five. A package boundary is worth it only where the compiler should enforce a
dependency rule.

**`core` performs no I/O.** No filesystem, no network, no database, no clock, no randomness. It is
pure functions and types. When something is hard to test, that is the signal to move the decision
into `core`, not to add a mock.

**`tui` never reaches past `harness`.** It talks to `harness` through its ports. The composition
root in `apps/tui/src/composition` is the only place that knows which implementation is bound.

`packages/codex-sdk` and `packages/pg-realtime` are pre-existing workspace packages.
`packages/agent-engine` has never been run — read as prior art, never import.

## `deprecated/`

`deprecated/` holds frozen reference code and is **not a pnpm workspace member**:

| Path                | What it was                                                              |
| ------------------- | ------------------------------------------------------------------------ |
| `deprecated/tui`    | The previous Atlas TUI, built over the Claude and Codex agent SDKs.      |
| `deprecated/backend`| Paused NestJS cloud harness.                                             |
| `deprecated/web`    | Paused Next.js front end for the cloud harness.                          |
| `deprecated/shared` | `@workspace/shared` — DTOs and enums for backend + web.                  |
| `deprecated/docs`   | The design docs for the above: wireframes, architecture, decisions.      |
| `deprecated/.github`| The CI and blue/green deploy workflows for the cloud stack.              |
| `deprecated/infra`  | Dockerfiles, Caddy, deploy scripts, prod compose.                        |

Read it for prior art. Never import from it, never extend it, and do not fix it. It does not
install and is not expected to build.

## Code style

- **Max 300 lines per file.** Split into focused modules if exceeded.
- **No `as any` casts.** Use proper types, generics, or `unknown` with type guards.
- **No `@ts-ignore` / `@ts-expect-error`.** Fix the type instead.
- **Strict TypeScript.** `strict`, `noUncheckedIndexedAccess`, no implicit `any`.
- **Early returns** over nested conditionals.
- **Named parameters** for functions with 2+ arguments.
- **Event handlers** prefixed with `handle`.
- **`E`-prefixed real TS enums** for value unions (`EEngine`, `EHookPhase`), not const-tuple + type.

## Comments

**Don't write them.** A comment is a second thing to maintain that the compiler cannot check, and
it silently rots the moment the code beneath it changes. Two artifacts, one truth, no enforcement.

Make the code say it instead:

- Rename the variable, function, or type until the line explains itself.
- Extract a well-named function rather than heading a block with a comment.
- Encode the constraint in the type system, where it is checked.
- Put the scenario in a test, where it is executed.

The one exception is a fact that **lives outside this repository** and therefore cannot drift when
the code is refactored: a provider's undocumented protocol quirk, a spec section number, a
deliberate deviation from a library's intended use and the bug that forced it. Those are durable,
so they are worth writing down. Link the source when there is one.

Never write a comment that restates the code, labels a section, marks a step number, or explains a
language feature. Delete those on sight when you encounter them.

No JSDoc on internal code. Exported API of a package may carry a one-line description where the
name genuinely cannot carry it alone.

This rule is inverted from what `deprecated/` does. Do not carry that density forward.

## Testing

- **Every new feature includes tests.** TDD preferred.
- Tests live in a sibling `__tests__/` directory as `*.spec.ts(x)`.
- `bun test` everywhere.
- Context assembly, hook resolution, and policy decisions are pure and belong to `core` — test them
  with plain data, never with a live model, a terminal, or a database.

## Git

- **Commit directly to `main`.** Never branch, never force-push, never `--no-verify`.
- **Never use `git stash`** unless explicitly asked.
- Conventional commits: `<type>(<scope>): <description>` — imperative, lowercase.
- No `Co-Authored-By` or "Generated with Claude" trailers.

## Workspace mechanics

**pnpm is the package manager.** pnpm 11 workspace (`pnpm-workspace.yaml`), Node 22.13 (`.nvmrc`),
pinned via `packageManager` in the root `package.json`. Install and link with pnpm only — never
`bun install` / `npm install` / `yarn`.

- Run scripts as `pnpm --filter <pkg> <script>` from the root, or `pnpm run <script>` in the package.
- Native/postinstall builds must be allowlisted in `pnpm-workspace.yaml` → `allowBuilds`.
- `typescript` and `react` are pinned repo-wide via `overrides`; don't bump them in one package.
- `injectWorkspacePackages` + `nodeLinker: isolated` keep single instances of peer deps. Changing
  either is a repo-wide decision.

**Bun is the runtime, not the package manager.** `dev` / `test` / `build` shell out to `bun`
because OpenTUI's renderer is a Zig library reachable only through Bun's FFI, and because
`bun build --compile` produces the shipped binary. Dependencies still come from pnpm.

Nest's optional peers need `--external` flags to bundle and every Nest upgrade can add another, so
**CI must actually build the binary**, not merely typecheck.

## Agent skills

### Issue tracker

Specs and issues live as markdown under `.scratch/<feature-slug>/`, which is gitignored. One
directory per effort: `spec.md` plus `issues/NN-<slug>.md` numbered from `01`, each carrying a
`Status:` line.

### Triage labels

The five canonical roles, verbatim: `needs-triage`, `needs-info`, `ready-for-agent`,
`ready-for-human`, `wontfix`.
