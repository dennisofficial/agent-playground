# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`tui/` is `@dltech/atlas-harness` — a local terminal harness over the Claude (and eventually Codex)
agent SDKs. It is the active app in this repo. See the root `CLAUDE.md` for repo-wide conventions.

## Commands

**pnpm installs, Bun runs.** Dependencies come from the pnpm workspace like everywhere else in the
repo — never `bun install`. But the scripts below shell out to `bun`, because OpenTUI's renderer is
a Zig native library reachable only through Bun's FFI. `tui/` is the only workspace that does this.

Run from `tui/` (or `pnpm --filter @dltech/atlas-harness <script>` from the root).

```bash
pnpm dev                       # launch the TUI (cwd-relative); `bun src/main.tsx <path>` opens a folder
scripts/atlas-dev [path]       # launch from source ANYWHERE — see the cwd/tsconfig trap below
ATLAS_DEBUG=1 pnpm dev         # enable Nest logging — OFF by default because stdout corrupts the frame
pnpm typecheck                 # tsc --noEmit
pnpm test                      # whole suite
pnpm test ./src/domain/__tests__/editor.spec.ts  # one file — the ./ is required, or bun treats it
pnpm test editor.spec                            #   as a filename substring filter (also useful)
pnpm test -t "steer"                             # by test name
pnpm build                     # embed migrations + bun build --compile → bin/atlas (~82MB, gitignored)
```

Database (authoring-time only — users never run these; the app self-migrates at startup):

```bash
pnpm db:generate               # prisma generate → src/generated/prisma (gitignored; run after clone)
pnpm db:migrate                # prisma migrate dev + regenerate src/store/migrations.generated.ts
pnpm db:migrate:reset          # greenfield — always available, no schema change must preserve data
pnpm grammars:update           # re-vendor Tree-sitter grammars from parsers-config.json
```

`bun build --compile` embeds the runtime and the Zig library, so the shipped binary needs nothing
installed. Tests are `bun:test`, not vitest — there is no vitest config here.

## Architecture

### Standalone by decision

The TUI imports **nothing** from `shared/`, `backend/`, or `packages/agent-engine`. It declares
every type it needs, including its own role/phase vocabulary. The single workspace dependency is
`@workspace/codex-sdk` — a vendor SDK, peer to `@anthropic-ai/claude-agent-sdk`, not a harness
abstraction. Do not "fix" this by reaching for shared types.

### Layering — arrows point inward

```
ui/       OpenTUI/React components, pages, hooks   ← may import anything below
app/      turn runner, stores, rotation, sessions  ← orchestration; no React
store/    repositories over Prisma                 ← no React, no engine
auth/     credentials, OAuth, engine homes         ← no React, no engine
engine/   ClaudeEngine + normalise()               ← no React, no Prisma
domain/   types, pure rules, editor, layout math   ← imports NOTHING but generated enums
```

`app/` is the only layer allowed to touch both `store/` and `engine/`. `domain/` is the one
deliberate exception to house DI style: plain pure functions, no `@Injectable`, because they are
called from render paths that cannot inject.

### Composition: NestJS standalone context

`main.tsx` boots `NestFactory.createApplicationContext(AppModule)` (~4 ms), resolves the root
services in `ui/services.tsx`, and hands them to React through one provider. Components never reach
into the container. The container is built **before** the renderer takes the screen so a migration
that throws prints to the user's real terminal.

**`emitDecoratorMetadata` is load-bearing and esbuild does not implement it.** If an injected
dependency arrives `undefined` at runtime, this is why — not the module graph. Bun reads
`tsconfig.json`'s decorator settings; `.swcrc` covers any swc-based path.

**And Bun reads that `tsconfig.json` from the CWD, not from the entry file.** `bun
/abs/path/to/tui/src/main.tsx` run from another repository picks up *that* repository's tsconfig,
loses the flag, and dies with `undefined is not an object (evaluating
'this.migratorService.migrate')`. Run from `tui/`, or use `scripts/atlas-dev`, which pins the cwd
and passes your directory as an argument. The compiled binary is immune (the transform is baked in
at build time), and so is any CLI subcommand that exits before building a container — neither is
evidence the source path works.

### The seam that matters: `normalise()`

There is deliberately **no `Engine` interface in v1** — `ClaudeEngineService` is a concrete class
calling `sdk.query()`. The future seam is `engine/normalise/`: SDK event → `domain/message.ts`
payload union, pure and table-tested. Nothing above `engine/` ever sees an SDK type.

Keep the SDK surface tiny: `normalise/*` is the only place SDK types are touched, the engine
services the only place SDK calls are made. Never mirror SDK types into `domain/`. When the SDK
moves, the blast radius should be two files and one fixture.

Codex is not implemented yet (roles are bound to it in `domain/role-engine.ts`, the engine is v1.1).

### Delta vs authoritative — persistence and rendering follow one rule

| SDK event | Renders to | Persists to |
|---|---|---|
| text / thinking **deltas** | live tail | nothing |
| text / thinking / tool_use / tool_result **blocks** | transcript | `ThreadMessage` |
| session id | breadcrumb | `EngineSession.engineSessionId` |
| rate limit | `5h` / `wk` meters | the running `Account` row |
| *everything* | nothing | `raw.jsonl` (per-session tape) |

Deltas are a view of a block being built; the block is the truth.

### Parallelism: one lane per thread

Threads run in parallel; turns within a thread do not. `TurnRunnerService` keeps a `Lane` per
thread (in-flight turn, write chain, preflight steers, usage) and `ConversationStoreRegistry.for(threadId)`
hands out one `ConversationStore` per thread. A single shared store was a live bug — job A's blocks
rendering inside job B's transcript. Never reintroduce process-wide turn state.

Opening a running thread calls `hydrate()`, not `reset()` — `reset()` would blank a working agent's
spinner, tail and steer queue.

### Accounts, auth, rotation

Atlas owns auth: multiple accounts, one active per turn, rotation on a usage wall.

- **Auth is per-turn, via env** (`CLAUDE_CODE_OAUTH_TOKEN` on the per-`query()` env). A shared
  credential file cannot be per-turn and would silently bill a turn to the wrong account.
- **`CLAUDE_CONFIG_DIR` points at ONE Atlas-owned home** (`~/.atlas/claude-home`). Isolate
  credentials, never session storage — per-account homes fragment transcripts and break rotation.
- **Rotation loses no context.** The API is stateless; same session, same resume id, next turn on a
  different token. The real cost is the per-account prompt cache.
- `~/.atlas/` is Atlas-owned and freely overwritten. The user's personal `~/.claude` / `~/.codex`
  are never read or merged. Path construction lives only in `domain/paths.ts`.
- Material is AES-256-GCM encrypted at rest under `~/.atlas/key` (0600).

### Store: SQLite, self-migrating, multi-instance

Several TUI instances are normal, not an edge case.

- `MigratorService` runs on **every start**, before `$connect()`, applying committed migration SQL
  through raw `bun:sqlite` inside `BEGIN IMMEDIATE`, writing Prisma's own `_prisma_migrations` rows.
  No Prisma CLI at runtime.
- Migrations are **embedded** into `src/store/migrations.generated.ts` by `scripts/embed-migrations.ts`,
  because a compiled binary has no filesystem beside it. `db:migrate` regenerates it and
  `migrator.spec.ts` fails if it drifts — never hand-edit either the generated file or a migration.
- WAL + `busy_timeout` are applied per connection (`store/pragmas.ts`). `busy_timeout` is the one
  that fails intermittently when forgotten.
- Multi-file Prisma schema at `prisma/schema/` — one file per repository, enums beside their models.
  Exactly one `generator`/`datasource` block across the whole folder (`schema.prisma`).
  `prisma.config.ts` takes `datasource.url` and **no** `adapter`; the runtime adapter
  (`prisma-adapter-bun-sqlite`) is constructed in `PrismaService`.

## OpenTUI gotchas

These have each shipped a bug already:

- **`<text>` does not nest.** It accepts strings, text nodes and styled text — a component returning
  `<text>` rendered inside another `<text>` throws at mount, and the type system cannot see it.
  `ui/__tests__/render-smoke.spec.tsx` mounts every component for real to catch this.
- **Grammars must be registered before the renderer mounts.** `registerGrammars()` calls
  `addDefaultParsers`, and a `TreeSitterClient` takes the default set once at construction.
- **Wide blocks need explicit width + bounded scrollbox + the right `wrapMode`**, or they escape
  their container.
- The renderer owns the alternate buffer, cursor and mouse, and restores them on every exit path.
  `exitOnCtrlC: false` — quit is handled in-app so the session lock is released first.
- The mouse drives the transcript, the keyboard drives the draft. Focus stealing by the scrollbox is
  what made PgUp/PgDn silently useless.

## UI conventions

- Full-screen pages over a navigation **stack** (`ui/navigation.ts`) — back is always `pop()`.
- Every `useKeyboard` listener fires for every key (no propagation to stop), so a global binding must
  be one no page claims. Only `ctrl+a` and `ctrl+c` are global.
- State reads go through `useSyncExternalStore` against `ConversationStore` — no Context cascade, no
  RTK. Deltas coalesce on a ~33 ms tick and reveal on a backlog drain so the tail streams smoothly.
- The composer is a real editor built from four pure `domain/` modules (`text-editor`,
  `editor-keymap`, `editor`, `composer-layout`). `applyKey` returning `consumed` is the arbitration
  rule between editing and scrolling, and it is pure because React does not apply setState updaters
  synchronously.
- Hints and trails **measure, they do not threshold**: give forms longest-first and let the widest
  that fits win.

## Testing

| Layer | How |
|---|---|
| `domain/` | plain unit tests; it is all pure functions |
| `engine/normalise/` | table-driven, SDK event in → domain payload out. Highest-value tests here |
| `app/turn-runner` | fake engine emitting a scripted event sequence + fake repos |
| `ui/` | mount for real via `createCliRenderer` + `createRoot` |

`engine/normalise/__tests__/scripted-turn.fixture.ts` (text → thinking → tool → result → text) is
the renderer's regression net, and the artefact that will prove the abstraction when Codex lands —
replay it through both normalisers and assert identical domain output.
