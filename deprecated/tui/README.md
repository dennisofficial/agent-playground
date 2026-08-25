# @dltech/atlas-harness

Atlas is a local terminal harness over the Claude (and eventually Codex) agent SDKs. This package is
the active app in the repo — see the root `CLAUDE.md` for repo-wide conventions and `tui/CLAUDE.md`
for the architecture.

## Setup

From a fresh clone, in order:

```bash
# 1. install — ALWAYS from the repo root, ALWAYS pnpm
cd /path/to/atlas
pnpm install

# 2. generate the Prisma client — src/generated/ is gitignored, so every clone needs this,
#    and every schema change needs it again
cd tui
pnpm db:generate

# 3. run
pnpm dev
```

Prerequisites: Node 22.13 (`.nvmrc`) and pnpm 11 (pinned by `packageManager` in the root
`package.json`; `corepack enable` will honour it). Bun is a devDependency, so `pnpm install` provides
it — no global install required.

### pnpm installs, Bun runs

`tui/` scripts shell out to `bun` because OpenTUI's renderer is a Zig native library reachable only
through Bun's FFI. Bun is a **runtime** here, not the package manager.

**Never run `bun install` (or `bun i`) in this directory.** It fails outright:

```
error: Workspace dependency "@workspace/codex-sdk" not found
Searched in "./*"
```

`@workspace/codex-sdk` lives at `packages/codex-sdk`, one level above `tui/`. Bun run from inside
`tui/` treats `tui/` as the workspace root and never looks up at the pnpm workspace. Even if it did
resolve, it would flatten the isolated `node_modules` layout that `nodeLinker: isolated` +
`injectWorkspacePackages` set up for the rest of the repo. Install from the root with pnpm.

## Running

```bash
pnpm dev                       # launch the TUI in the current directory
bun src/main.tsx <path>        # launch it against another folder
ATLAS_DEBUG=1 pnpm dev         # Nest logging — off by default, stdout corrupts the frame
pnpm typecheck                 # tsc --noEmit
pnpm test                      # bun:test, not vitest
pnpm build                     # → bin/atlas, a self-contained ~82MB binary (gitignored)
```

Any script also runs from the repo root as `pnpm --filter @dltech/atlas-harness <script>`.

The app self-migrates its SQLite store on every start, so there is no database step beyond
`db:generate`. `pnpm db:migrate` and friends are authoring-time only.

## Troubleshooting

**`SyntaxError: Export named 'EPhaseKind' not found in module .../src/generated/prisma/enums.ts`**
(or any other missing export from `src/generated/`) — the generated Prisma client is stale or absent.
Run `pnpm db:generate`. This is the usual symptom of pulling a branch that changed `prisma/schema/`.

**`error: Workspace dependency "@workspace/codex-sdk" not found`** — you ran `bun install` in `tui/`.
See above; run `pnpm install` from the repo root instead.

**An injected dependency is `undefined` at runtime** — `emitDecoratorMetadata` is load-bearing and
esbuild does not implement it. Check the decorator settings in `tsconfig.json`, not the module graph.
