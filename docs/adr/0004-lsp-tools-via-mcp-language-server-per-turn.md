# ADR 0004 — LSP-backed refactor/navigation tools, spawned per-turn (TypeScript/JavaScript v1)

- **Status:** Accepted — implemented and live-validated. A re-rooting launcher was added after the first
  live run exposed a monorepo failure; see the **2026-07-03 addendum** at the end.
- **Date:** 2026-07-03

## Context

The job brain and the build orchestrator/writer subagents rename symbols and find usages the same
expensive way a human without an IDE would: `grep` for text matches, `Read` every candidate file into
context, regenerate each file with the change, `Write` it back. That is N files of input **and** output
tokens for what an IDE does semantically in one command — because an IDE keeps a type-aware **language
server** (LSP) warm in memory, so a rename returns a precise `WorkspaceEdit` instead of a fuzzy text
search. The goal of this change is to give Atlas's agents the same capability, scoped to TypeScript/
JavaScript first (more languages added later by pointing the same machinery at another language server).

The interesting design question was not *whether* to add LSP tools but *how the warm program survives
Atlas's execution model*: every engine turn is a **fresh, one-shot `docker exec`** into a long-lived
per-job container (see ADR 0001) — there is no standing engine process a language server's stdio session
can persist into across turns. Three shapes were considered:

1. **Build a small warm daemon ourselves** — a long-lived sidecar owning one `typescript-language-server`
   session, exposing a handful of ops over a unix socket that thin per-turn MCP tools connect to.
2. **Adopt Serena as a warm daemon** — run it in its standalone SSE/HTTP server mode.
3. **Adopt `mcp-language-server` (isaacphi), spawned per-turn** as an external stdio MCP server — no
   daemon at all; the SDK spawns and kills it with the turn.

A spike (`ortho-backend-v3`, the biggest single codebase available: ~478k LOC, ~34 real `tsconfig.json`
projects, pnpm-symlinked `node_modules`) measured what a language server's warm-up actually costs, since
that number decides how much a daemon is worth building:

| Project | Files (incl. `.d.ts`) | Full type-check (proxy for warm-up) |
|---|---|---|
| shared | 514 | 0.86s |
| server | 5,392 | 2.8s (7.4s on a cold OS file cache) |
| client | 3,075 | 6.0s (the worst single project) |
| whole monorepo, cumulative | — | ~17s |

(Measured on the author's Mac; scale roughly 1.5–2.5× for the Linux sandbox container.)

## Decision

**Adopt `mcp-language-server`, spawned fresh per turn**, registered as an external stdio MCP server
(`atlas-lsp-ts`) alongside the existing in-process `atlas-host-bridge` server. Two facts from the spike
made this the right call over the daemon options:

- **Warm-up is cheap and identical across all three options.** All three drive the same
  `typescript-language-server`/`tsserver` underneath — the wrapper doesn't do the indexing. Single-digit
  seconds for any project size seen in the spike means the daemon's warmth advantage (skip re-warming) is
  worth only a few seconds per turn, not the tens of seconds originally assumed.
- **Per-turn spawn bounds memory; a daemon accumulates it.** `tsserver` loads TypeScript "projects"
  **lazily per `tsconfig.json`, only for files a turn's tool calls actually open** — it does not eagerly
  load every project in a monorepo (confirmed: this is also exactly how an IDE avoids loading a whole
  monorepo at once). A per-turn process therefore only ever holds the 1–2 projects a given turn touches,
  and the whole process **exits with the turn, reclaiming that memory**. A warm daemon instead holds the
  **union of every project ever touched over the container's lifetime** and never releases it — `client`
  alone measured ~1.5GB RSS, so a monorepo with several distinct projects touched over a job's life could
  plausibly want several GB resident continuously. Sandbox containers are not memory-capped
  (`dockerode-container-engine.ts` sets no Docker `Memory` limit), so this would not hard-fail, but it is
  a needless standing cost against host RAM shared across concurrent jobs.

`mcp-language-server` was chosen over building our own wrapper because it is a single self-contained Go
binary that already does exactly the per-turn-process shape we want: `rename_symbol` applies its own
`WorkspaceEdit` to disk and returns a compact text summary (files + line:column locations, not file
content) — confirmed by reading its source (`internal/tools/rename-symbol.go`), not just its README —
which is the whole token-savings premise. `references`/`definition`/`hover`/`diagnostics` come for free.
Adding a language later is a `--lsp <command>` flag change, not new code.

Serena (the other adopt candidate) was rejected for v1: it is a *framework* where we want a *component*
— a Python runtime + its own project/config model (`.serena/project.yml`), and critically its own
**memory** and **onboarding** systems that would sit alongside (and confuse the model relative to) Atlas's
existing pgvector memory and onboarding thread. Its SSE-daemon mode does get real warmth, but that
advantage is small per the spike, and not worth the framework overlap.

### What's actually exposed

- Registered only for **execute-mode turns** (`mode: 'execute'`) — this covers both the brain/chat turn
  and the build orchestrator/writer turns (both run `mode: 'execute'`; see `agent-session-manager.service.ts`
  and `thread-driver.service.ts`), and excludes plan/review/investigate turns, which can't Write/Edit
  anyway and would spawn a language server for nothing.
- Tool surface is `rename_symbol` / `references` / `definition` / `hover` / `diagnostics` — deliberately
  **excluding** `mcp-language-server`'s sixth tool, `edit_file` (a generic line-range text editor with no
  LSP semantics), which would be redundant with, and easily confused for, the SDK's native `Edit` tool.
- `rename_symbol` (the only mutating tool) is given only to the personas that already have `Write`/`Edit`
  — the orchestrator and the `implement`/`implement-deep` writer subagents. The read-only investigator
  subagents (`explore`/`review`/`debug`) get the navigation subset only.
- Auto-approved via `allowedTools`/subagent `tools:` (same tier as the host-bridge tools), not routed
  through `canUseTool`'s Write/Edit path check — that check is a native-tool-specific defense-in-depth,
  not a universal invariant every mutating tool implements (Bash isn't routed through it either). The real
  confinement is `mcp-language-server --workspace <turn's cwd>`: tsserver cannot rename a symbol in a path
  outside the workspace root it was given, the same way Bash is confined by the sandbox container itself.

## Consequences

**Positive:** a project-wide rename becomes one tool call in, a changed-files summary out — the edited
bytes never enter the model's context, collapsing what would be a many-file read-and-rewrite (tens to
hundreds of thousands of tokens on a large monorepo) into a couple thousand. Read-only subagents get
type-accurate `references`/`definition` instead of a grep-and-guess loop. Memory stays bounded and
self-cleaning by construction. Adding Go/Python/Rust support later is a config change, not new
infrastructure.

**Negative / costs:** the ~2–15s language-server warm-up (parse+bind; full type-check is more) is paid on
every execute turn that uses the tools, not once per container — accepted as a small, bounded cost in
exchange for not accumulating memory. **Cross-package rename can be incomplete**: because `tsserver` loads
projects lazily per file actually opened, a symbol exported from a shared package and consumed by two
sibling packages may only be rewritten in the packages a given turn happened to load, silently missing a
sibling that was never opened. Mitigated by explicit prompt guidance (verify with `references`/a search
after a cross-package rename; use a codemod like `ast-grep` when string/comment occurrences also need to
change) and by the repo's own `tsc` pass the agent already runs before closing a build step — this ADR
deliberately does **not** add a separate host-enforced "done gate" type-check, since that would be
redundant with verification the agent already performs. `rename_symbol`/`references`/`definition` also
have a real precision seam worth naming: `rename_symbol` is position-based (`filePath`/`line`/`column`)
but `references`/`definition` are name-based (`symbolName`, e.g. `"MyType.MyMethod"`), which can be
ambiguous when two unrelated symbols share a name in different scopes.

## Alternatives considered

- **Build a small warm-daemon sidecar ourselves** (a long-lived process holding one `tsserver` session,
  thin per-turn tools over a unix socket): rejected for v1. It is real code we would own and debug — a
  broker + process lifecycle (crash detection, restart, re-init after a sandbox reset) — to save only the
  few seconds of warm-up the spike showed is cheap already, while trading away the per-turn memory
  self-cleaning. Revisit only if per-turn re-warm proves painful in practice (most likely on the brain's
  frequent short chat turns, less likely on long build turns).
- **Adopt Serena as a warm SSE daemon:** rejected for v1 — see Decision above (framework/runtime overlap
  with Atlas's own memory + onboarding systems, for a warmth benefit the spike showed is marginal).
- **A host-enforced project-wide type-diagnostic "done gate"** before a build thread can declare success:
  considered and dropped from this change entirely — the build orchestrator already runs the repo's own
  `tsc`/typecheck before finishing (`VERIFY_NOTE`/`MONOREPO_VERIFY_HINT`), so a second, separately-built
  gate would duplicate work the agent already does reliably.

## Status & rollout

## Addendum — 2026-07-03: re-rooting launcher (first live validation)

The first live job on a real monorepo (`cubix-infra`, ~14 per-package `tsconfig.json`, no root tsconfig)
surfaced a failure the original design missed: `mcp-language-server` v0.1.1 takes ONE fixed `--workspace`
at spawn and **eagerly opens every file under it**, and the turn's cwd is ALWAYS the repo root
(`sandbox.worktreePath` → `/workspace`, for both the brain and build turns — there is no per-package
turn signal). Pointed at the monorepo root it opened ~970 files, and a `rename_symbol` then crawled
references across every loaded project and **timed out (>90s)**. Rooted at the target package
(`/workspace/daemon`, 49 files) the identical rename completed in seconds. So the eager-open-all under a
too-broad root — not the position-based rename logic — was the defect. Empirically confirmed alongside:

- **`rename_symbol` (position-based) is reliable** once deps are installed: it renamed a symbol across
  **7 files / 17 occurrences** in one call, returning only a summary. This is the headline win, intact.
- **`references`/`definition` (name-based via `workspace/symbol`) remain unreliable** — that LSP request
  is flaky in TS monorepos regardless of root; treat them as best-effort, grep is the fallback (unchanged
  from the "Negative / costs" section above; the launcher does not fix them — they carry no `filePath`).
- **`rename_symbol` needs an ABSOLUTE `filePath`** — a package-relative path is mis-resolved on apply.

**Fix: `backend/sandbox/atlas-lsp-launcher.mjs`** — a tiny stdio MCP proxy the engine now spawns (via
`/usr/local/bin/node`) IN PLACE OF `mcp-language-server` for the `atlas-lsp-ts` server. It proxies the
MCP session and, on the first tool call carrying a `filePath` (rename_symbol/hover/diagnostics), walks up
to that file's nearest `tsconfig.json` and (re)starts the underlying server rooted THERE — the same
project tsserver itself would select. It also normalizes a relative `filePath` to absolute. Name-based
calls (references/definition) have no path and run against the current/repo root. This is a minimal form
of the "build a small warm-daemon" alternative this ADR had deferred — a per-turn *re-rooting* proxy, not
a warm daemon (the child still dies with the turn, preserving the memory-bounded property above).

Wired via `buildLspBridgeOptions` (command → the launcher), the Dockerfile (COPY + `node --check`), and
`sandbox-image.builder.ts`'s `CONTEXT_FILES` (so `ensureImage` auto-rebuilds on shim change). **Live-
validated end-to-end**: a real brain job on `cubix-infra` installed deps, called `mcp__atlas-lsp-ts__rename_symbol`,
and renamed cross-file (7 files) in one call with no timeout — the launcher re-rooted repo-root → package.

## Addendum — 2026-07-03 (later): direct LSP client, `mcp-language-server` dropped

The launcher fixed rename, but `references`/`definition` stayed unreliable — and a clean-room re-test
pinned why: `mcp-language-server` (v0.1.1 **and** `main`) resolves those two tools **by name**, via LSP
`workspace/symbol` (a fuzzy nav-to search) + exact-match. `workspace/symbol` is flaky in TS monorepos;
`references` for `StatusReporter` (12 real usages) returned **0** across every root/deps/settle
combination tried. No version or config fixes it — there is no position-based `references` anywhere in
`mcp-language-server`. `rename_symbol` worked only because it is already **position-based**
(`textDocument/rename` at a file+line+col), which the model always has from a Read/grep.

**Decision: replace `mcp-language-server` with our own direct LSP-client MCP server**
(`backend/sandbox/atlas-lsp-server.mjs`). It speaks MCP (newline-delimited JSON-RPC) to the SDK and LSP
(`Content-Length`-framed JSON-RPC) directly to `typescript-language-server`, and makes **all five tools
position-based**: `references`/`definition`/`hover`/`rename_symbol` take `filePath`+`line`+`column`
(1-indexed → 0-indexed for LSP), `diagnostics` takes a `filePath`. The flaky `workspace/symbol` path is
gone entirely. It keeps the launcher's re-rooting (spawn the language server at the target file's
nearest `tsconfig.json`) and relative→absolute path normalization, and — because it no longer needs a
workspace symbol index — **skips `mcp-language-server`'s eager "open all files", opening only the target
file** (tsserver lazily loads just that project), so startup/memory drop further. `rename` applies the
`WorkspaceEdit` to disk itself (bottom-up per file); `diagnostics` opens the file and collects
tsserver's async `publishDiagnostics`.

This resurrects this ADR's original **"build a small wrapper"** alternative — but as a per-turn client
(the child still dies with the turn, so the memory-bounded property holds), not the rejected warm
daemon. The Go build stage + `mcp-language-server` are removed from the Dockerfile;
`typescript-language-server` (the actual language server) is retained.

**Cost:** we now own an LSP client (protocol framing, `didOpen` lifecycle, WorkspaceEdit application,
async diagnostics). Adding a language later is still a `--lsp` flag, but each server has quirks.
**Validated:** all five tools on a multi-file TS project — `references` returned all 6 cross-file
usages (the exact failure case, now correct), `definition`/`hover`/`diagnostics` accurate, `rename`
rewrote 3 files on disk.

**Residual limitation (unchanged):** re-rooting scopes `references`/`rename` to the target file's
package; a sibling package's usages need that package loaded. Reliable *within* the package; grep/tsc
remain the cross-package backstop.

## Status & rollout

Implemented: `backend/sandbox/Dockerfile` (multi-stage Go build of `mcp-language-server` + global
`typescript`/`typescript-language-server` install), `backend/src/app/engine/lsp-tools.ts` (shared
tool-name constants), `backend/src/app/sandbox/image/lsp-bridge-options.ts` (SDK option assembly, mirrors
`bridge-options.ts`), `engine-entrypoint.ts` (merges the LSP bridge into the same `mcpServers`/
`allowedTools` the host bridge uses), `engine-core.ts` (subagent `tools:` wiring — explicit per subagent,
not inherited from the parent turn), and prompt-kit fragments (`LSP_TOOLS_NOTE`/`LSP_NAV_NOTE`) spliced
into the brain (`Agent.ATLAS_MAIN`), the orchestrator (`Agent.WORKER`), and the writer/read-only subagent
prompts (`Agent.FAN_OUT`/`EXPLORE`/`REVIEW_AGENT`/`DEBUG`). Not yet live-validated against a real job.
