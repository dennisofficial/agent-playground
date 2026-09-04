# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository.

## What this repo is

Atlas is a **coding-agent harness**. Not a wrapper around someone else's harness — the agentic
loop is ours. We make raw LLM calls through the Vercel AI SDK and own every decision the loop
makes: what context the model sees, which tools it may call, when a human is asked, what happens
on rewind.

Because we make raw model calls, Atlas is model-agnostic by construction. Claude and Codex
subscription credentials are one provider implementation among several, not a foundation.

## Who uses Atlas

**One person: Dennis.** There is no user base, no support burden, no migration window, and no
untrusted third party. Weigh decisions accordingly — a breaking change costs one afternoon, a
plugin loaded from disk is his own code in his own repo, and a feature nobody has asked for is a
feature nobody needs. Spend the saved effort on the things a single user still feels every day:
a hang, a silent failure, a seam that makes the next feature cheap.

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

## `deprecated/`

`deprecated/` holds frozen reference code and is **not a Bun workspace member**:

| Path                      | What it was                                                            |
| ------------------------- | ---------------------------------------------------------------------- |
| `deprecated/tui`          | The previous Atlas TUI, built over the Claude and Codex agent SDKs.    |
| `deprecated/agent-engine` | `@workspace/agent-engine` — never-run EngineAdapter port. Prior art.   |
| `deprecated/codex-sdk`    | `@workspace/codex-sdk` — JSON-RPC client for the `codex app-server`.   |
| `deprecated/backend`      | Paused NestJS cloud harness.                                           |
| `deprecated/web`          | Paused Next.js front end for the cloud harness.                        |
| `deprecated/shared`       | `@workspace/shared` — DTOs and enums for backend + web.                |
| `deprecated/docs`         | The design docs for the above: wireframes, architecture, decisions.    |
| `deprecated/.github`      | The CI and blue/green deploy workflows for the cloud stack.            |
| `deprecated/infra`        | Dockerfiles, Caddy, deploy scripts, prod compose.                      |

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

## Dependency injection

**Bun cannot run tsyringe's decorators.** Bun's transpiler rewrites legacy decorators as TC39
standard decorators and silently drops constructor-parameter decorators, so `@inject(...)` and
`@injectAll(...)` never execute under Bun no matter what `experimentalDecorators` or
`emitDecoratorMetadata` says. tsyringe's `TypeInfo not known for "X"` is the symptom that
reaches tests.

Therefore classes never carry tsyringe decorators — the registrar decides construction:

- Zero-argument constructor → `container.register(token, { useClass: X })`.
- Any constructor parameters → `container.register(token, { useFactory: (resolver) =>
  new X(resolver.resolve(dep)) })`.
- One instance per container → wrap the factory in `instanceCachingFactory`.

Spec-side wiring follows the same rule: construct with `new X(...)` rather than resolving a class
token out of a container. Tokens resolve ports and symbol keys; class tokens are for zero-arg
classes only.

## Testing

- **Every new feature includes tests.** TDD preferred.
- Tests live in a sibling `__tests__/` directory as `*.spec.ts(x)`.
- `bun test` everywhere.
- Context assembly, hook resolution, and policy decisions are pure and belong to `core` — test them
  with plain data, never with a live model, a terminal, or a database.

## Git

- **Work in a worktree; the main checkout is read-only between merges.** Cut a worktree under
  `.claude/worktrees/<slug>` from `origin/main`, do the work there, and merge back into `main`
  locally when done — no PR, no review gate. Remove the worktree after the merge. This is
  load-bearing, not hygiene: `atlas-dev` runs from the main tree and flags every running terminal
  as stale the moment the tree moves, so direct edits in the main checkout turn that notice into
  noise.
- Never force-push, never `--no-verify`.
- **Never use `git stash`** unless explicitly asked.
- Conventional commits: `<type>(<scope>): <description>` — imperative, lowercase.
- No `Co-Authored-By` or "Generated with Claude" trailers.

## Workspace mechanics

**Bun is both the package manager and the runtime.** `bun install` from the repo root installs the
whole workspace; `bun.lock` is committed. Workspace members are declared in the root
`package.json` → `workspaces` (`packages/*`, `apps/*`). Never `pnpm install` / `npm install` /
`yarn`. `.nvmrc` still pins Node 22.13, for the node-based CLIs in root `devDependencies`.

The runtime was already Bun and still is, for the reasons it always was: OpenTUI's renderer is a
Zig library reachable only through Bun's FFI, and `bun build --compile` produces the shipped
binary. The package manager has simply stopped being a second tool.

- `typescript`, `react`, `react-dom`, and their `@types` are pinned repo-wide via root
  `package.json` → `overrides`; don't bump them in one package. Those pins are the only thing
  keeping a single instance of each — Bun's isolated linker does not dedupe across versions.
- `bunfig.toml` pins the **isolated** linker: real packages live in `node_modules/.bun/` and each
  member's `node_modules` holds symlinks to exactly its declared dependencies, so a package you did
  not declare will not resolve. Bun 1.3 already defaults to this for workspaces; the file makes it
  a decision rather than a default we inherited.
- Lifecycle scripts run only for packages on Bun's default allowlist. Nothing in the live workspace
  currently needs more; if `bun pm untrusted` ever reports a blocked postinstall, add that package
  to root `package.json` → `trustedDependencies` and say why.

**Turborepo runs the tasks.** `bun run typecheck` / `test` / `build` at the root are
`turbo run <task>`; `turbo.json` holds the graph. Per-package scripts still call `tsc` and
`bun test` directly — turbo orchestrates, it is not the runner.

- Run one package with `turbo run <task> --filter @dltech/atlas-core`, or `bun run <script>` inside
  the package.
- `typecheck` and `test` declare `outputs: []` — they produce no artifacts, only an exit code.
- Every task declares `dependsOn: ["^<task>"]`. That is load-bearing, not ordering garnish: the
  packages are raw TS with no build step, so a change in `core` must invalidate `tui`'s cached
  typecheck, and the topological edge is what makes it do so.
- `tsconfig.base.json` is in `globalDependencies`; editing it busts every cache entry.

**CI must actually build the binary**, not merely typecheck. Bundling a Bun binary surfaces failures a
typecheck cannot: runtime assets loaded by path, and optional peer dependencies that need `--external`.
Nest was the original reason for that warning and now lives only under `deprecated/`, but the class of
failure is not specific to it — the tree-sitter grammars are the live example.

## Agent skills

### Issue tracker

Specs and issues live as markdown under `.scratch/<feature-slug>/`, which is gitignored. One
directory per effort: `spec.md` plus `issues/NN-<slug>.md` numbered from `01`, each carrying a
`Status:` line.

### Triage labels

The five canonical roles, verbatim: `needs-triage`, `needs-info`, `ready-for-agent`,
`ready-for-human`, `wontfix`.
