# Daily-driver gaps

An audit of `apps/tui` + `packages/{core,harness}` against "could I use this instead of Claude Code
today". Ordered by what stops you, not by size.

Re-verified against the working tree (189 uncommitted files, typecheck green across all three
packages). What the code has closed since the first pass is listed at the bottom.

## What already works

The loop (`harness/loop/run-turn.ts`), the event log, streaming into the transcript, steering a
running turn, undo, rewind, compaction on demand and automatically, background shells with the
sidebar, the `ctrl+t` panel and an exit guard that names what would die, twelve builtin tools,
instruction-file loading (`CLAUDE.md` / `AGENTS.md`, nested, reloaded per turn), slash commands,
skills and the command menu, the model/effort switcher, layered settings, a spend ledger, the raw
tape, markdown with two-tier syntax highlighting, table panning and side-by-side diffs, plan
mirroring from `task_write`.

## P0 — blocks daily driving

1. **Threads are not scoped to a workspace.** `Thread` still has no `cwd` column
   (`harness/prisma/schema.prisma:16`) and `openConversation` calls `threads.mostRecent()`, which is
   `findFirst({ orderBy: { updatedAt: 'desc' } })` across the whole database. Open Atlas in a second
   repo and it resumes the conversation from the first one, with the wrong `CLAUDE.md` already in
   the log. Needs a workspace column, a scoped `mostRecent`, and scoped listing.

2. **No session picker and no thread listing.** `ThreadStorePort` exposes `mostRecent` and nothing
   that lists. So there is no session history, and the only way to reach an older conversation is to
   be the last one who touched it. `--new` / `/new` is the whole navigation story. `/resume` is free
   for the picker: turn resumption is now the clickable resume block alone.

3. **Nothing guards the filesystem any more, and nothing can approve.** Two halves of one hole:

   - The working tree **removes `WorkspaceBoundaryHook`**. `hooks/boundary.ts`,
     `hooks/__tests__/boundary.spec.ts` and `tools/__tests__/containment.spec.ts` are deleted and
     `registerBuiltinHooks` no longer binds it, leaving `ReadBeforeWriteHook` as the only
     `BeforeToolHook` — and it checks staleness, not location. So `write` / `edit` outside the
     workspace root is now unchecked, where it used to be denied. Deliberate or not, it is the
     largest single behavioural change sitting uncommitted.
   - Approvals still never happen. `tools/dispatch.ts:85` emits `approval-requested` on
     `EBeforeToolDecision.Ask` and `loop/run-turn.ts:177` pauses on it, but **no hook ever returns
     `Ask`** and **nothing ever appends `approval-answered`** (zero non-test hits). `bash` inherits
     `TAKES_NO_PATHS`, so `cat ~/.ssh/id_rsa`, `rm -rf ~` and `curl | sh` run unprompted. The moment
     any hook does return `Ask`, the turn pauses with no UI able to answer it —
     `composition/turn-progress.ts:115` renders "The turn is waiting: …" and that is the end of it.

   Needs: the boundary hook back or a note saying why not, a shell-command classifier, allow / ask /
   deny lists in settings, and the approval overlay + `EDecision` append path in the TUI.

4. **No credential refresh, and macOS only.** `KeychainCredentialPort` reads the Claude Code
   keychain blob and `credentials/expiry.ts:24` throws if it is stale — the advice is literally "run
   `claude` once to refresh it". There is no refresh-token exchange, no API-key port, no `auth.json`
   backend, no `security`-free reader, so Linux is dead on arrival and a long day ends with Atlas
   exiting at boot until you open Claude Code. The check also happens once at boot, so expiry
   mid-session surfaces as a failed turn.

5. **No transient-error *automatic* retry.** `model/ai-sdk-model-port.ts:79` turns any stream error
   into `ModelStreamError` and `loop/model-step.ts:31` ends the turn `Failed`. Manual recovery is
   there — `ctrl+r` on the error block re-runs the turn with nothing appended, and the resume block
   covers the interrupt case — but a 429, a 529 overloaded, or a dropped socket still needs a human to
   press it. No backoff, no rate-limit awareness. The only backoff in the codebase is
   `store/retry.ts`, for SQLite write conflicts.

## P1 — high friction

6. **The system prompt is four fragments.** The registry landed — `harness/src/prompt/fragments/`,
   resolved through the container — and it is the right shape. The prose is still identity + project
   directory + absolute paths + compaction notice. No date, no platform, no shell, no git
   branch/status, no directory listing, no tone or verbosity rules, no tool-selection guidance
   ("prefer grep over bash grep", "read before edit", "never commit unless asked"). The plumbing
   problem is solved; the content problem is untouched, and it is still the cheapest quality win
   available. `.scratch/prompt-registry/issues/02-the-prose.md` is the open issue.

7. **No `@`-file mentions.** `core/commands/mention.ts` parses `/name` for skills only. There is no
   way to point the model at a file from the composer, and no path completion.

8. **No sub-agents / `task` tool.** Architecturally reserved (`runId`/`parentRunId`/`depth` on every
   event, `EForkMode`) and explicitly not safe yet — `docs/architecture.md` lists six invariants that
   break when a child inherits rows. Every "go read these forty files" job burns the main context.

9. **No web access.** No `web_fetch`, no `web_search`. Any doc lookup has to go through `bash curl`,
   which is also the tool with no gate — see P0 3.

10. **Cost and usage are invisible.** The ledger records four token tiers per turn and
    `MODEL_CATALOG` carries prices; `ui/switcher-model.ts:83` renders a per-model price, but nothing
    sums a session. No `/cost`, no session total. The footer shows context pressure only.

11. **User-authored commands and hooks.** Skills load from embedded + `~/.atlas/skills` + project,
    but there is no `.atlas/commands/*.md` equivalent, and hooks are compiled-in classes only — no
    settings-driven `PreToolUse` / `PostToolUse` shellouts.

12. **No headless mode.** `resolveConfig` understands `--model`, `--new`/`-n` and four env vars.
    No `-p/--print`, no stdin piping, no `--resume <id>`, no JSON output, so Atlas cannot be
    scripted or used in CI.

13. **Only Anthropic is reachable.** `modelIsReachable` hard-codes `EModelVendor.Anthropic`;
    `gpt-5-codex` sits in the catalog purely to render as unavailable. No codex-oauth provider, no
    OpenAI/Gemini/local via API key, which undercuts the model-agnostic claim in practice.

14. **No images.** No paste-image path, no image parts in `core/message` — zero hits for `image`
    anywhere in `core` — so screenshots and design references are out.

## P2 — parity items, deliberately deferred

MCP server lifecycle, sandbox/container isolation, PR shipping, phases and phase briefs, session
rotation across accounts, `/doctor`, `/export`, terminal-title updates, notification bell, vim mode,
transcript search, and `core/budget/resolveBudget` as the auto-compaction controller.
`docs/architecture.md` names most of these; none needs a decision reopened.

## Closed since the first audit

- **Auto-compaction is wired.** `useConversation.compactIfFull` runs after every turn against
  `ESettingId.AutoCompact` (`context.autoCompact`, 90% by default). Only `resolveBudget`, the
  fixpoint controller, is still unused.
- **The prompt registry** replaced the five-line `MINIMAL_PREAMBLE` literal with DI-resolved
  fragments. `assembly/rules/system-preamble.ts` is deleted.
- **Interrupt granularity.** `tools/builtin/bash.ts:190` terminates on abort and
  `shells/shell-process.ts:45` signals the whole process group via `setsid`, SIGTERM then SIGKILL
  after a grace period. Partial output is preserved.
- **The failing slash-command test** (`app-commands.spec.tsx:190`, stray newline on completion) — the
  completion path was rewritten.
- **The `ctrl+c` exit guard** now names the background shells that would die, and refuses to go
  stale or let a turn start behind it.

## Health

- `bun run typecheck` is clean across core, harness and tui.
- **The `bash` sleep guard refused commands it should have allowed.** `waitsBySleeping`
  (`core/shells/idling.ts`, added in `2579aa3f`) ran before `timeoutMs` was known, so a command that
  could not outlive its explicit 300 ms ceiling was refused for "spending 32 seconds asleep" — which
  is what broke `BashTool > kills the whole process group on timeout`. The check now runs after the
  timeout is resolved and measures `idledSeconds` as the lesser of the sleeping and the timeout.

  Two flaws in it remain, both needing real shell parsing rather than a regex: `sleptSeconds` sums
  across `&`, so concurrent sleeps of 2 s and 30 s read as 32 s; and it cannot tell a `sleep` inside
  quoted data from one that will run, so a heredoc *containing* the text `sleep 120` is refused.
- **`test` declares `dependsOn: ["^test"]`, so one harness failure hides the whole tui suite.**
  While that `bash` test was red, `bun run test` reported "1 successful, 2 total" and never ran
  `@dltech/atlas` at all. Worth knowing independently of the bug that exposed it: a single upstream
  failure silently blanks downstream signal.
- **The tui suite went from 8m17s to 18.5s.** Fixed, and worth writing down because two plausible
  diagnoses were wrong before the right one turned up.

  The earlier "exceeds five minutes" figure was measured with `bun test` at the repo root, which
  sweeps `deprecated/` — meaningless. Honest baseline: core + harness **15 s** via turbo, tui
  **1926 pass / 0 fail in 8m17s**, of which only 54 s was user CPU. The suite was idle-waiting, not
  computing, and every wait in it was a *worst case* charged as a *fixed cost*.

  What actually paid off, in order:

  1. `teardown` (`markdown/__tests__/harness.ts`) slept `HIGHLIGHT_SETTLE_MS = 400` on all 138 call
     sites. It now polls for a settled frame with 400 ms as a *ceiling*, so an in-flight tree-sitter
     highlight still gets its full grace and everything else returns in ~10 ms. Same for `drawn`
     (`transcript-fixture.tsx`) and its 250 ms. Those two took the serial run to **158 s**;
     `transcript-render` + `tool-group-render` alone went 78 s → 6.2 s.
  2. `app-rewind.spec.tsx` had its own helpers with `settle(1_500)` per message — 45 s in one file.
     Rewritten against `frameShowing({ setup, text })`, which returns the instant the text lands:
     **48.9 s → 6.5 s**, same 22 assertions.
  3. Sharding across processes (`scripts/test-shards.ts`): **158 s → 18.5 s**.

  Two things that did *not* work, so nobody retries them:

  - **`bun test --parallel` is unusable here.** It implies `--isolate`, and @opentui/core 0.4.5
    cannot initialise its Zig render library in an isolated worker — every `testRender` dies with
    "Cannot access 'default' before initialization". It runs in 5 s and fails 442 tests. `--shard`
    uses ordinary processes and is fine. Revisit when that upstream bug is fixed.
  - **`waitFor` / `waitForFrame` from @opentui/core are not general-purpose waits.** Both break out
    of their loop the moment the scheduler reports no running, rendering or scheduled work, so
    neither can span an await the renderer knows nothing about — a scripted model step, a summariser
    delay. That is why the original author reached for sleeps. `frameWhen` in
    `ui/__tests__/waiting.ts` polls the captured frame with a yield instead, which does span them.

  And one real constraint: **a settled frame is not a safe wait for an animated screen.** Two
  captures taken microseconds apart match while the interrupt spinner or shimmer is still moving, so
  `app-fixture.frame()` keeps its timed settle deliberately — swapping it cost three failures in
  `app-resume` and `app-undo`, and the comment there now says why.
- **`act()` warnings** throughout the composition specs.
- Two files over the 300-line rule: `composition/use-conversation.ts` (551) and
  `composition/app.tsx` (453).
- 189 uncommitted files, several of them deletions with real behavioural weight: the boundary hook
  above, `system-preamble.ts`, the containment specs.
- The dev database is `~/.atlas/dev.db` (`DEV_DATABASE_NAME`). Shipping under that name is a trap.

## Suggested order

1. Workspace-scoped threads + `list()` + a session picker. (P0 1, 2)
2. Settle the boundary hook, then write the prompt prose. (P0 3a, P1 6)
3. Credential refresh + an API-key port. (P0 4)
4. Retry with backoff. (P0 5)
5. Command classifier, permission settings, approval overlay. (P0 3b)
6. `@`-mentions, `/cost`, web fetch. (P1 7, 10, 9)
