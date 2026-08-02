# Handoff — Local Atlas TUI: scaffold and build

## Next session's job

Implement the TUI scaffolding: folder structure, code architecture, Prisma setup with
**auto-migration on startup**, and **multi-instance safety**. Then get the thing running so
Dennis can review and dial in the layout and feel.

The design phase is done and written up. **Do not redesign — implement.**

## Read these first

| Doc | What it is |
|---|---|
| `docs/tui-wireframes.md` | Every page and state, the message grammar, the validated Prisma schema, the **v1 cut line** (what to build vs defer) |
| `docs/tui-architecture.md` | Folder structure, layering, dependency rules, startup/migration, multi-instance, accounts/auth/rotation, testing |

Everything below is context those two don't carry: how decisions were reached, what was
rejected, and what is still unverified.

## Where this stands

Nothing is written yet. No `tui/` directory exists. The two docs above are the entire output
of this conversation. `docs/orchestration-shapes.md` and `.scratch/session-orchestration/` are
a **different, parallel effort** (phase transitions) — don't pull from them.

> **⚠ All three docs are untracked** (`git status` shows `??` for `tui-wireframes.md`,
> `tui-architecture.md`, and this file). Nothing from this work is committed. **Commit them
> before doing anything else** — a stray `git clean` loses the entire design phase. Dennis
> commits directly to `main`; no `Co-Authored-By` trailers.

### Memory is already loaded

This project has file-based memory at
`~/.claude/projects/-Users-dennis-Developer-atlas/memory/`, auto-loaded via `MEMORY.md`. The
relevant entries were written during this session and will be in context already:

- `atlas-local-tui` — the full decision set, kept current through every reversal
- `prisma-sqlite-facts` — the measured Prisma 7 + SQLite behaviour below
- `atlas-agent-engine-package` — why `agent-engine` is unproven and unused
- `atlas-context-folder-contract` — the `/context` bucket semantics from legacy

If they contradict this file, **this file and the two docs win** — they were written last.

## Decisions that will look wrong without their reasoning

These were argued out and reversed at least once each. Re-deriving them costs time.

1. **Fully standalone.** No `@workspace/shared`, no `@workspace/agent-engine`, nothing from
   `backend/`. The TUI declares every type it needs. The *only* workspace dep is
   `@workspace/codex-sdk` — a vendor SDK, peer to `@anthropic-ai/claude-agent-sdk`, not a
   harness abstraction.

2. **`packages/agent-engine` is deliberately unused.** It looks like exactly the right
   abstraction and Dennis has **never run it** — binding a greenfield prototype to an untested
   dependency makes every bug two questions. Read it as prior art; don't import it.

3. **No `Engine` interface in v1.** Concrete `ClaudeEngine` calling `sdk.query()`. The
   interface gets extracted later from two working implementations. What *is* built now is
   `normalise()` — SDK event → domain payload, pure and well-tested. That is the future seam.

4. **Legs are `EngineSession`s, not `Thread`s.** A Thread is one role / one continuous
   conversation; rotation opens a new session under it. Messages hang off the **thread**
   (tagged with `sessionId`), so the transcript is continuous by construction and the rotation
   seam is *derived* from adjacent messages changing session. Nothing stitches anything.

5. **Account rotation does NOT create a new session and loses NO context.** I claimed the
   opposite; Dennis caught it. The API is stateless — the transcript is resent each turn, a
   "session" is a local file + resume id, so **auth is a per-turn concern**. UI is a dim inline
   `⤿` note, not a seam. Real cost is the per-account **prompt cache**, which the swap
   invalidates.

6. **Corollary — isolate credentials, never session storage.** Per-account home dirs break
   rotation on *both* engines (Claude's transcript lives under the config dir;
   `CodexClientOptions.codexHome` is passed straight through as `CODEX_HOME`, which holds
   `auth.json` *and* session/rollout storage). One Atlas-owned home per **engine**.

7. **No permissions at all.** Atlas allows everything — no approval card, no permission mode,
   no `shift+tab`, no `waiting` run state.

8. **Claude Code's TUI is the visual target**, built on Ink (MIT). The "reconstructed Claude
   Code" GitHub repos are rebuilt from Anthropic's March 2026 source-map leak — **do not clone
   or copy from them** (Dennis offered; the answer stayed no). Match observable rendered
   behaviour instead. Ink's `<Static>` is what preserves native scrollback.

## New instructions from this handoff's arguments

Already folded into `docs/tui-architecture.md`, flagged here so they aren't missed:

- **Auto-migrate on startup.** `prisma migrate dev` is authoring-time only. At runtime, read
  the committed `migration.sql` files, diff against an applied table, apply with
  better-sqlite3. No Prisma CLI at runtime.
- **Multi-instance is normal.** `journal_mode=WAL` + `busy_timeout=5000` on every connection —
  the second one is easy to forget and fails intermittently. Wrap check-and-apply migration in
  `BEGIN IMMEDIATE` so only one instance migrates.
- **Agent homes are Atlas-owned**, under `~/.atlas/`. Personal `~/.claude` / `~/.codex` are
  **not** read, merged, or respected; Atlas overwrites its own homes freely.
- **Atlas extends Claude and Codex, it does not replace them.** The load-bearing consequence is
  architectural: **keep the SDK surface tiny**. `normalise()` is the only place SDK types are
  touched; `ClaudeEngine` / `CodexEngine` are the only places SDK calls are made. Never
  reimplement SDK behaviour, never mirror SDK types into `domain/`. A thin adapter *is* the
  update strategy — when the SDK moves, the blast radius is two files and one fixture.
  Staleness *detection* (`/doctor`, `codex --version`, a daily registry check) is the cheap
  part and is specced in `docs/tui-architecture.md`.

## Verify before relying on it

- **The Claude credential-injection mechanism.** Env var vs config dir, against the *installed*
  SDK version. The shape is settled (Atlas-owned home, credential swapped per turn); the exact
  variable name is the one load-bearing thing in these docs that was never confirmed.
- **Ink `<Static>` behaviour on resize** — committed output will not reflow. Accepted, but
  worth seeing before building around it.

## Verified facts (don't re-test)

Measured against the repo's Prisma 7.9.1 during this session; also saved to memory as
`prisma-sqlite-facts`:

- SQLite supports `enum` **and** `Json`; rejects `String[]` scalar lists.
- Enum values need **separate lines**; the compact `{ a b }` form is a parse error reported on
  the *following* enum.
- Enums compile to bare `TEXT`, **no CHECK constraint** — enforcement is Prisma-side only.
- `prisma.config.ts` needs **both** `datasource.url` and `adapter`; adapter alone fails
  `db push` with "The datasource.url property is required".
- `@prisma/adapter-better-sqlite3@7.9.1` exists; `@prisma/adapter-node-sqlite` does **not**,
  despite Node 22.13 shipping `node:sqlite`. No zero-native-dep path.
- `prisma db push` has no `--skip-generate` flag in v7.
- The schema in `docs/tui-wireframes.md` **validates and pushes clean** — 7 tables: `Account`,
  `Project`, `Job`, `ThreadGroup`, `Thread`, `EngineSession`, `ThreadMessage`.
- `better-sqlite3` is already in the root `pnpm-workspace.yaml` `allowBuilds` allowlist.
- `tui/` must be added to `pnpm-workspace.yaml` (globs are `packages/**`, `backend`, `shared`,
  `web`).
- Node 22.13 (`.nvmrc`), pnpm 11.18. Repo Prisma is 7.9.1 — match it.
- Current upstream versions as of this session: `@anthropic-ai/claude-agent-sdk` npm latest
  `0.3.220` (backend pins `^0.3.204`); `codex-cli 0.142.5` installed at `~/.local/bin/codex`,
  and `codex --version` works — so the `/doctor` check is trivially implementable.

## Useful prior art in-repo (read, don't import)

- `backend/src/engine/runner/runner.service.ts` — 122 lines, the smallest correct example of
  driving the Claude SDK. **Model `ClaudeEngine` on this.**
- `backend/src/_shared_old/engine/engine-core.ts` — 1088 lines, cloud-soaked. **Do not port.**
- `backend/src/host/agent-credentials/oauth/` — working Claude PKCE paste-back and Codex
  device-code clients. Port the flows (~100 lines each); don't import.
- `packages/codex-sdk/src/codex-client.ts` — `init/startThread/resumeThread/startTurn/steer/
  interrupt`. This one **is** a dependency.
- `web/src/features/job-workspace/components/chrome/usage-ring.tsx` — the 5h/weekly meter
  semantics the footer mirrors.

## Working style that applied here

- Dennis commits directly to `main`; never branch.
- No `Co-Authored-By` or "Generated with Claude" trailers in commits.
- Assume the dev server is already running; never start one without asking.
- He tests UX and feel himself — ship it and say "test this" rather than burning runs
  self-validating. This matters for the "review and dial in the layout" part of the task:
  **get it runnable and hand it over.**
- ASCII wireframes in the docs were alignment-checked with a script; if you edit them, re-check
  rather than eyeballing. The script is ~20 lines and was not kept: walk fenced code blocks,
  collect lines starting with `┌│└├╭╮╰╯`, and report any block whose border lines disagree on
  `[...line].length`. Two blocks flag legitimately — the annotated trees in "The shape of the
  thing" and the page map are ragged on purpose, not boxes.

## Suggested skills

- **`nestjs-best-practices`** — *skip*. The TUI is deliberately not NestJS (a CLI pays
  framework boot on every invocation). Noted only to preempt reaching for it.
- **`empty-states`** — worth invoking. The wireframes specify first-run / no-jobs /
  no-rotations / nothing-shared states, and this skill covers doing them well.
- **`run`** — for launching the TUI to see it working, once there is something to launch.
- **`prototype`** — if the layout needs throwaway exploration before committing to components.
- **`codex:rescue`** — if the Ink render loop or the streaming/steer plumbing gets stuck.
- **`update-config`** — only if permission prompts become noisy enough to warrant an allowlist.

Plan-mode plans are auto-reviewed by Codex via a global hook. **Don't also invoke
`codex:codex-rescue` on a plan-mode plan** — that double-reviews.
