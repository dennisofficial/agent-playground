# Daily-driver gaps

An audit of `apps/tui` + `packages/{core,harness}` against "could I use this instead of Claude Code
today". Ordered by what stops you, not by size.

Re-verified against the working tree, typecheck and tests green across all three packages. What the
code has closed since the first pass is listed at the bottom.

## What already works

The loop (`harness/loop/run-turn.ts`), the event log, streaming into the transcript, steering a
running turn, undo, rewind, compaction on demand and automatically, background shells with the
sidebar, the `ctrl+t` panel and an exit guard that names what would die, twelve builtin tools,
instruction-file loading (`CLAUDE.md` / `AGENTS.md`, nested, reloaded per turn), slash commands,
skills and the command menu, sub-agents with a sidebar roster and a readable child transcript,
the model/effort switcher, layered settings, a spend ledger, the raw
tape, markdown with two-tier syntax highlighting, table panning and side-by-side diffs, plan
mirroring from `task_write`, and an account vault that refreshes its own logins.

## P0 — blocks daily driving

1. **No transient-error *automatic* retry.** `model/ai-sdk-model-port.ts:79` turns any stream error
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

8. **Sub-agents are built, bar one deliberate omission.** The feature shipped end to end — four
   agent types, five tools, a supervisor, a sidebar roster, a child transcript reachable by `ctrl+g`
   or `/agents`, `ctrl+k` to stop one, reports that reach the parent's prompt through
   `agentEndingsBlock`, endings that wake the parent, running children named in the exit guard,
   recovery that writes an ending for a child the session lost, and a delegated-cost line at the
   foot of the transcript. What remains:

   **No operator-facing spawn**, and that one is deliberate — choosing a type and writing a brief
   is the model's job, and a human who wants a sub-agent can ask for one in a sentence. `spawn`,
   `resume` and `types` stay model-only; `list`, `say` and `stop` are the three the TUI needs.

9. **No web access.** No `web_fetch`, no `web_search`. Any doc lookup has to go through `bash curl`,
   which is ungated by design — see "Accepted, not gaps".

10. **Cost across a session is invisible.** The ledger records four token tiers per turn and
    `MODEL_CATALOG` carries prices; `ui/switcher-model.ts:83` renders a per-model price, and one
    conversation now shows what its sub-agents cost as a line at the foot of the transcript
    (`readThreadSpend` over `forThreadTree`, tri-state so a failed read says so rather than
    reporting zero). What is still missing is the level above: no `/cost`, no total across
    conversations, no spend-to-date. The footer shows context pressure only.

11. **User-authored commands and hooks.** Skills load from embedded + `~/.atlas/skills` + project,
    but there is no `.atlas/commands/*.md` equivalent, and hooks are compiled-in classes only — no
    settings-driven `PreToolUse` / `PostToolUse` shellouts.

12. **No headless mode.** `resolveConfig` understands `--model`, `--new`/`-n` and four env vars.
    No `-p/--print`, no stdin piping, no `--resume <id>`, no JSON output, so Atlas cannot be
    scripted or used in CI.

13. **Only Anthropic is reachable.** `modelIsReachable` hard-codes `EModelVendor.Anthropic`;
    `gpt-5-codex` sits in the catalog purely to render as unavailable. The credential side is now
    ready for the others — `PROVIDER_SPECS` declares OpenAI's device-code flow and OpenRouter's API
    key, and an api-key account already reaches Anthropic through `x-api-key` — but no second
    `LanguageModelV4` provider is wired, so the model-agnostic claim is still one adapter short.

14. **Images work.** Closed. `core/message` carries an `ImagePart`, `read` returns a picture for an
    image file, ctrl+v pulls a screenshot off the macOS clipboard, and `imagesInContext` stops old
    ones being re-billed every step. Rendering goes through OpenTUI 0.5.9's native
    `ImageRenderable` at `protocol="auto"`, so a terminal answering the kitty handshake gets real
    full-resolution pixels and everything else falls back to quadrant glyphs; decode is native, so
    PNG, JPEG, WebP and GIF all paint. Remaining limits are narrow: clipboard pull is macOS-only,
    and tmux forces the block fallback.

## Accepted, not gaps

**Filesystem guarding and tool approvals are out of scope for the daily driver.** The working tree
deletes `WorkspaceBoundaryHook` (`hooks/boundary.ts`, its spec, and
`tools/__tests__/containment.spec.ts`), leaving `ReadBeforeWriteHook` as the only `BeforeToolHook`,
which checks staleness rather than location. No hook returns `EBeforeToolDecision.Ask`, nothing
appends `approval-answered`, and `bash` inherits `TAKES_NO_PATHS`, so every command runs unprompted.
That is the intended posture: a single trusted operator on a local machine, where a confirmation
prompt costs more than it buys. The machinery stays where it is —
`dispatch.ts:94` still emits `approval-requested` and `run-turn.ts:188` still pauses on it — so a
future sandboxed or multi-tenant deployment can supply a hook and an overlay without reopening the
loop. Until then, no classifier, no permission lists, no approval UI.

One decision is already taken for whenever that changes: **a sub-agent's `Ask` routes to the parent
agent, never to a human overlay.** A child is managed by the main agent, so the request is something
the parent answers with a tool call of its own; do not extend the human overlay to render it. The
honest half of that is already in place — a child whose turn pauses ends as `EAgentStatus.Blocked`
and the parent is told it is blocked on an approval it cannot answer — but the ending carries no
`callId`, and `agent_resume` on a blocked child re-enters the turn and pauses again. Answering the
approval, rather than re-entering, is the approval effort's job.

## P2 — parity items, deliberately deferred

MCP server lifecycle, sandbox/container isolation, PR shipping, phases and phase briefs, session
rotation across accounts, `/doctor`, `/export`, terminal-title updates, notification bell, vim mode,
transcript search, and `core/budget/resolveBudget` as the auto-compaction controller.
`docs/architecture.md` names most of these; none needs a decision reopened.

## Closed since the first audit

- **Sub-agents run.** A child is a real thread Atlas spawned — its own row carrying
  `spawnerThreadId` and `agentType`, its log and brief written in one transaction by
  `createWithFirstEvents`, its loop stepped unawaited under its own `AbortController`. Two things
  distinguish it from the main agent and no others: the five agent tools are denied to it, which
  caps depth at one by construction, and its system prompt is its agent type's prose compiled under
  `EPromptAgent.Sub`. Four types ship embedded and `~/.atlas/agents/*.md` and
  `<project>/.atlas/agents/*.md` shadow them project over user over built-in, with a refusal rather
  than silence for a definition that will not load. Reports reach the parent's model through
  `agentEndingsBlock`, which collapses a wave of endings into one spliced block on a shared prose
  budget. `ctrl+g` and `/agents` walk to a child, `ctrl+k` stops one, and the ending says who
  stopped it — `EKilledBy` now covering `Unrecorded` for a child the session lost before it could
  report. Five of the six fork invariants in `docs/architecture.md` closed on the way, including the
  rewind hole — `ERewindRefusal.UnendedSubAgent` refuses a cut below a live child.

- **Read-before-write is per thread, locked, and content-aware.** `ToolCall` carries a required
  `threadId` and `FileReadStatePort` keys views on `{ threadId, path }`, so a sub-agent's read no
  longer vouches for its parent's write. `FileWriteGuardPort.underLock` puts the whole
  verify-then-write inside a per-path in-process mutex, which **eliminates** the agent-versus-agent
  race outright — every sub-agent runs in this process — and `FileView.digest`, consulted by
  `movedSince` only when mtime and size agree, closes the content-blind predicate. A concurrent
  external editor is **narrowed and not closed**, which no in-process lock can do; `writeFileAtomically`
  is a separate guarantee again, that no reader sees a half-written file.

- **A run from a checkout keeps its state in the checkout.** `atlasDirectory()` now resolves through
  `core/workspace/atlas-home.ts`: `ATLAS_HOME` wins if set, otherwise a source launch lands in
  `<repo>/.atlas-home` and only the compiled binary uses `~/.atlas`. The binary is told apart by its
  modules living under Bun's `/$bunfs` mount, so `bun run dev`, `bun src/main.tsx` and `bun test` all
  get the local home without a flag. Database, settings, tapes, skills and the account vault follow
  it, each writer already `mkdir -p`-ing its own directory, and `importClaudeCodeAccount` re-seeds a
  fresh dev home from `~/.claude` on boot. `dev.db` is gone: dev and shipped state are separated by
  home now, not by filename, so the default database is `harness.db` in both.

- **`@`-file mentions, browsed like `cd`.** `core/mentions/file-mention.ts` parses `@path` out of a
  message — past email addresses, `react@19` and code spans — and `core/mentions/browse.ts` splits
  what is being typed into the directory to list and the fragment to filter it by. `FileBrowser`
  (harness) reads one level at a time and resolves `~`, an absolute path and a climb out of the
  workspace alike, so `@~/Developer/other-project/` browses as readily as `@src/`. `⇥` on a
  directory appends its slash and opens the next level; on a file it settles with a space. Rows
  read as one path, folders dimmed and the name lit, shortened powerlevel10k-style from the
  outside in when the row is too narrow (`ui/path-shorten.ts`). A chosen path attaches as
  `EContextSlot.File`: text truncated at 128 KB with a notice, a directory as its listing,
  anything binary refused. The composer paints a mention only once the filesystem has confirmed it
  — one question per spelling, memoised — so what is lit is what will be attached, and a mention
  that names nothing sends as ordinary prose. `ui/highlight-offsets.ts` carries the one quirk that
  costs: `addHighlightByCharRange` addresses the buffer with line breaks removed.

- **A session picker.** `/resume` lists the conversations in this workspace off the `list()` the
  store already exposed, through `use-threads.ts` and `ui/threads-model.ts`.

- **A conversation belongs to a workspace.** `87ab439b` added `workspace` and `repo` to `Thread`
  with an `@@index([workspace, updatedAt])`, `core/workspace/identity.ts` and the harness probe that
  resolves them. `mostRecent` and `list` are both scoped, and a thread predating the attribution is
  adopted by whoever opens it by id, so opening Atlas in a second repo no longer resumes the first
  one's conversation with the wrong `CLAUDE.md` in the log.

- **Credentials refresh themselves, hold more than one account, and no longer need macOS.**
  `RefreshingCredentialPort` reads an account out of `~/.atlas/auth.json` (0600, aes-256-gcm under
  `~/.atlas/key`), refreshes inside a five-minute skew with one in-flight exchange per account, and
  writes the rotated pair back to the Claude Code keychain item it was imported from so `claude`
  keeps working. `ctrl+a` / `/auth` lists accounts, signs in by pasted code, takes an API key,
  switches and removes; `ANTHROPIC_API_KEY` shows up as an account of its own. A boot that cannot
  authenticate now opens the overlay carrying the reason instead of exiting.
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
- 114 uncommitted files, including an in-flight tool-rendering rewrite (`store/tool-groups.ts` →
  `store/tool-runs.ts` + `store/tools/`, `tool-group-block.tsx` → `tool-run-block.tsx`) and an
  unstaged usage-metering slice (`core/usage/`, `harness/usage/`, `account-usage.port.ts`). The
  boundary-hook and `system-preamble.ts` deletions in there are intended — see "Accepted, not gaps".


## Suggested order

1. Retry with backoff. (P0 1)
2. The prompt prose. (P1 6)
3. `/cost`. (P1 10)
4. Web fetch. (P1 9)
