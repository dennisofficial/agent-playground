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

9. **Navigation is a ladder, not a hierarchy you walk.** Three decisions, one reasoning: the depth
   of the stack must equal the depth of the thing.

   - **The job list is the root, and a project is a SCOPE on it, not a level above it.** One frame,
     ever; `←` widens it and the switcher rewinds to it. Pushing a scoped list on top of the
     unscoped one gave two frames that drew identically, so `p` → project produced the same header,
     the same rows, and a different `←` — a page that lied about where you were. It also put a `‹`
     on the root, whose `←` had nothing to pop and therefore did nothing.
   - **The job's own page is ABOVE the conversation, not beneath it.** Opening a job used to push
     both, so `←` out of a conversation revealed the job on the way past. That made one key mean
     "leave" everywhere in the app and "manage this job" in exactly one place, and those are
     opposite intentions — the key you reach for to walk away from a working agent should not be the
     one that stops to ask you about phases. `→` on an empty composer asks for the job's page now,
     and `←` is uniformly "the frame below".
   - **A back affordance appears only where the key goes somewhere.** `‹` is drawn from whether
     there is anywhere to go, never unconditionally. A promise the keyboard cannot honour is worse
     than silence, exactly as with a hint line naming a key that does nothing.

   The first-run empty state falls out of the same rule: the unscoped list cannot offer `+ new job`
   (a job needs somewhere to live), so it offers `+ pick a project…` rather than a blank page under
   a hint line of verbs that all need a row to act on.

10. **Atlas's system prompt is APPENDED to Claude Code's, never substituted for it.** The SDK
    reads a bare `systemPrompt` string as a *custom* prompt and drops the `claude_code` preset
    entirely; the preset form (`{ type: 'preset', preset: 'claude_code', append }`) keeps it and
    adds to it. Atlas's own prompt is three short sections about the harness — the envelope
    vocabulary, the canary, the phase brief — and none of them says anything about how to use
    `Edit`, how to read a repository, or what the working directory is. Handing an agent those
    three sections *instead of* the preset takes the coding agent away and leaves the etiquette,
    and it does so quietly: the session still answers and still calls tools, it is just worse.

    This is a v1-scale decision, not a permanent one. It is right precisely *because* Atlas's own
    prompt is currently small. If the harness ever grows a full operator manual of its own —
    enough to stand alone and enough to start contradicting the preset — the argument for
    appending weakens and this should be revisited deliberately rather than inherited.

    One deliberate exception, in `oneShotOptions`: an ask is the model as a function and is given
    nothing it does not need, so loading a coding agent's whole manual to title a job would be the
    opposite policy for no gain.

11. **A job takes a worktree through four doors, and all four write `Job.workspacePath`.** Job
    creation, the build confirm, `enter_worktree`, and adoption from the jobs list. That field is
    the entire justification for Atlas owning a worktree verb at all when Claude Code ships a
    native one: the native tool relocates the work and tells Atlas nothing, leaving the job drawn
    under `⌂ here`, its later turns running in the project tree, and `ship_pr` pointed at the
    wrong branch.

    Door three went unbuilt for a while and the failure was exactly that, in the wild: asked for a
    worktree, the agent shelled out to `git worktree add`, and the job kept working in the tree the
    worktree existed to keep it out of. **A verb an agent needs and does not have is not an absent
    feature — it is a shell command with no bookkeeping.**

    Two shapes follow from where the tool sits:

    - **It mints; it never adopts.** `WorktreeService.adopt` exists, but choosing which *existing*
      tree to stand in is a human move made from the jobs list. An agent picking for itself would
      be picking, with no way to tell, the tree Dennis has an editor open on.
    - **It cannot move the turn that calls it.** A turn's `cwd` is handed to a subprocess already
      running in it. So the reply's main content is the warning — *stop writing, you are not there
      yet* — and the move lands at the next turn boundary, where `syncCursor` notices
      `workspacePath` changed and reopens the conversation against the new directory. Without that
      last step the tool would fix the record and reproduce the original bug one layer up.

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

**The same failure has a second trigger, and it needs no unusual tooling at all: `bun` resolves
`tsconfig.json` from the process's CWD, not from the entry file.** So running the TUI from source
against another repository —

```
cd ~/Developer/comp-v2 && bun ~/Developer/atlas/tui/src/main.tsx
```

— reads *comp-v2's* tsconfig, which does not set `emitDecoratorMetadata`, and dies on the first
injected dependency to be dereferenced:

```
TypeError: undefined is not an object (evaluating 'this.migratorService.migrate')
```

It reads as a bug in Atlas and is not one; the entry path being absolute is what makes it look like
cwd should not matter. Two things do not reproduce it and are therefore no evidence that it is
fixed: the compiled binary (`bun build --compile` applies the transform at build time, from `tui/`),
and any `atlas <subcommand>` CLI invocation that exits during argument parsing, before a container
is ever built. Use `scripts/atlas-dev`, which pins the cwd to `tui/` and passes the directory you
were standing in as an explicit argument.

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
