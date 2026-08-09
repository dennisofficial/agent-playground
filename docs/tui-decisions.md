# Local Atlas TUI — decision record

Why the TUI is shaped the way it is. Companion to `docs/tui-wireframes.md` (what it looks like)
and `docs/tui-architecture.md` (where the code lives).

Everything here was argued out and reversed at least once. Re-deriving it costs time, and the
code cannot show you a road not taken.

## Decisions that look wrong without their reasoning

1. **Fully standalone.** No `@workspace/shared`, no `@workspace/agent-engine`, nothing from
   `backend/`. The TUI declares every type it needs. The *only* workspace dep is
   `@workspace/codex-sdk` — a vendor SDK, peer to `@anthropic-ai/claude-agent-sdk`, not a
   harness abstraction.

2. **`packages/agent-engine` is deliberately unused.** It looks like exactly the right
   abstraction and it has **never been run** — binding a greenfield prototype to an untested
   dependency makes every bug two questions. Read it as prior art; don't import it.

3. **No `Engine` interface in v1.** Concrete `ClaudeEngine` calling `sdk.query()`. The interface
   gets extracted later from two working implementations. What *is* built now is `normalise()` —
   SDK event → domain payload, pure and well-tested. That is the future seam.

4. **Legs are `EngineSession`s, not `Thread`s.** A Thread is one role / one continuous
   conversation; rotation opens a new session under it. Messages hang off the **thread** (tagged
   with `sessionId`), so the transcript is continuous by construction and the rotation seam is
   *derived* from adjacent messages changing session. Nothing stitches anything. The
   orchestration effort has since adopted this same job → phase → thread → session shape.

5. **Account rotation creates no new session and loses no context.** The API is stateless — the
   transcript is resent each turn, a "session" is a local file plus a resume id, so **auth is a
   per-turn concern**. UI is a dim inline `⤿` note, not a seam. The real cost is the per-account
   **prompt cache**, which the swap invalidates.

6. **Corollary — isolate credentials, never session storage.** Per-account home dirs break
   rotation on *both* engines (Claude's transcript lives under the config dir;
   `CodexClientOptions.codexHome` is passed straight through as `CODEX_HOME`, which holds
   `auth.json` *and* session/rollout storage). One Atlas-owned home per **engine**, under
   `~/.atlas/`. Personal `~/.claude` / `~/.codex` are not read, merged, or respected.

7. **No permissions at all.** Atlas allows everything — no approval card, no permission mode, no
   `shift+tab`, no `waiting` run state.

8. **Atlas extends Claude and Codex; it does not replace them.** The load-bearing consequence is
   architectural: **keep the SDK surface tiny.** `normalise()` is the only place SDK types are
   touched; `ClaudeEngine` / `CodexEngine` are the only places SDK calls are made. Never
   reimplement SDK behaviour, never mirror SDK types into `domain/`. A thin adapter *is* the
   update strategy — when an SDK moves, the blast radius is two files and one fixture.

## Standing prohibition

**Claude Code's rendered behaviour is the visual target. Do not clone or copy from the
"reconstructed Claude Code" GitHub repos** — they are rebuilt from Anthropic's March 2026
source-map leak. Match observable behaviour instead. This was offered and declined; the answer
does not change.

## Silent failure mode

**NestJS needs `emitDecoratorMetadata`, and esbuild does not implement it.** It fails *silently* —
decorators still compile, so every injected dependency arrives `undefined` at runtime rather than
erroring at build time. Bun's transpiler honours the `tsconfig.json` flag, so the current runtime
is fine; the trap is any tool that swaps in an esbuild-based transform. If DI "mysteriously"
returns undefined, this is why — do not go hunting in the module graph.

## Measured facts

Prisma 7.9.1 against SQLite:

- SQLite supports `enum` **and** `Json`; it rejects `String[]` scalar lists.
- Enum values need **separate lines**; the compact `{ a b }` form is a parse error reported on
  the *following* enum.
- Enums compile to bare `TEXT`, **no CHECK constraint** — enforcement is Prisma-side only.
- `prisma db push` has no `--skip-generate` flag in v7.
- `PrismaConfig` has **no `adapter` field**. `datasource.url` alone drives the CLI; the runtime
  adapter is constructed in `PrismaService`. An `adapter` key in `prisma.config.ts` is a `tsc`
  error and is ignored at runtime. (An earlier draft of these docs claimed both were required —
  that was wrong.)

## Prior art in-repo — read, don't import

- `backend/src/engine/runner/runner.service.ts` — 122 lines, the smallest correct example of
  driving the Claude SDK. `ClaudeEngine` is modelled on this.
- `backend/src/_shared_old/engine/engine-core.ts` — 1088 lines, cloud-soaked. **Do not port.**
- `backend/src/host/agent-credentials/oauth/` — working Claude PKCE paste-back and Codex
  device-code clients. Port the flows (~100 lines each); don't import.
- `packages/codex-sdk/src/codex-client.ts` — `init/startThread/resumeThread/startTurn/steer/
  interrupt`. This one **is** a dependency.
- `web/src/features/job-workspace/components/chrome/usage-ring.tsx` — the 5h/weekly meter
  semantics the footer mirrors.

## Editing the wireframes

The ASCII boxes in `docs/tui-wireframes.md` were alignment-checked with a script. If you edit
them, re-check rather than eyeballing: walk fenced code blocks, collect lines starting with
`┌│└├╭╮╰╯`, and report any block whose border lines disagree on `[...line].length`. Two blocks
flag legitimately — the annotated trees in "The shape of the thing" and the page map are ragged
on purpose, not boxes.
