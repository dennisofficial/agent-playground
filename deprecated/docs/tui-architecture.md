# Local Atlas TUI — code architecture

Companion to `docs/tui-wireframes.md`. What gets built, where it lives, and which way the
dependencies point.

## Standalone

**Fully standalone.** Own schema, own types, own engine wiring, own turn loop. It imports
nothing from `shared`, nothing from `agent-engine`, nothing from `backend/`. Every type it
needs, it declares.

That includes the phase and role vocabulary. Restating nine enum members is cheaper than
adopting `shared`'s, which is stale anyway — `EThreadGroupKind` there has no `intake` and no
`design` and still carries `direct_build` / `plan_review`. The live vocabulary is being settled
in `.scratch/session-orchestration/`.

It lives at `tui/` in this repo, added to `pnpm-workspace.yaml` alongside `backend` / `web` /
`shared`.

### The one exception: `@workspace/codex-sdk`

`codex-sdk` is a **vendor SDK, not a harness abstraction** — the same category as
`@anthropic-ai/claude-agent-sdk`, and the only reason it is a workspace package rather than
an npm one is that nobody publishes a decent typed Codex client. Depending on it is not
coupling to the cloud harness; it is using the Codex client that exists instead of writing a
JSON-RPC client by hand.

```ts
class CodexClient {
  init()  startThread()  resumeThread()  startTurn()
  steer(threadId, turnId, input)         // mid-turn steer
  interrupt(threadId, turnId)
}
```

That is a direct match for the wireframes: thread lifecycle, a turn, mid-turn steer, and
interrupt. Turn handlers are `{ onEvent, onApproval }` — and with permissions gone,
`onApproval` gets a blanket approve.

**Runtime prerequisite:** it spawns `codex app-server` as a child process, so the `codex`
binary must be installed and authenticated (`codexHome`).

*(Corrected 2026-08-02. This paragraph used to claim "Claude runs in-process; Codex does not —
that asymmetry is real". It is not: the installed `@anthropic-ai/claude-agent-sdk` spawns a
Claude Code **subprocess** per `query()`, and `Options.env` is documented as replacing that
subprocess's environment wholesale. Both engines spawn. The asymmetry that survives is narrower —
Codex needs a binary the user installs and Atlas does not control, Claude's arrives as an npm
dependency — and it still belongs in the engine layer.)*

The distinction that matters: `codex-sdk` is **in** because it is a vendor client;
`agent-engine` is **out** because it is the abstraction over vendors, and re-deriving that is
the point.

### Why not reuse `packages/agent-engine`

It exists, it looks like the right abstraction, and it is **unproven** — never run in anger.
Binding a greenfield prototype to an untested dependency means every bug becomes two
questions instead of one: is my rendering wrong, or is the adapter wrong?

There is also concrete evidence its shape is wrong for local use. `AdapterRunArgs` requires
`sandboxKey: EngineHomeKey` — `{ orgId, repoId, jobId, type }` — and `mode: EngineMode`. A
local TUI has no org and no repo, so conforming would mean synthesising `'local'` into every
row forever, or widening a package the backend depends on. Both are taxes paid for a seam
that has not yet earned its keep.

**Read it, don't import it.** It is prior art in your own repo, and two ideas in it are worth
taking on their own merits (below). When the TUI works and a second engine lands, compare the
two designs and extract the real seam from two working implementations. That is the honest
version of "abstract later".

---

## No engine interface in v1

The instinct is to define `interface Engine { run() }` immediately. Don't.

v1 has one engine. A port needs a real swap **and a live second consumer**; the swap is
planned but the consumer is not here yet, and an interface guessed from one implementation is
exactly the artefact that gets thrown away. Write a concrete `ClaudeEngine` class that calls
`sdk.query()` directly — model it on `backend/src/engine/runner/runner.service.ts` (122
lines), which is the smallest correct example of driving the SDK in this repo.

**What to do now instead** is keep the boundary that makes extraction cheap later:

```
  ClaudeEngine  ──emits──▶  normalise()  ──▶  domain message  ──▶  store + UI
                            ^^^^^^^^^^^
                            the future seam
```

`normalise()` is a real, pure, well-tested function from the day it exists. Nothing above it
ever sees an SDK type. Codex gets its own `normalise()`, both feed the same domain union, and
the interface falls out of the two rather than being invented before either.

With `codex-sdk` already in hand, that second implementation is close — v1.1, not someday. The
two clients are shaped differently enough to make the point: Claude takes a streaming input
generator and hangs `interrupt()` off the query handle; Codex takes explicit `(threadId, turnId)`
on `steer` and `interrupt`. An interface guessed from only the first would have missed that.

Two lessons worth taking from `agent-engine` without importing it:

1. **Split live deltas from authoritative blocks.** Its `EngineEvent` union marks `*_delta`
   kinds live-only and the full blocks (`text` / `thinking` / `tool_use` / `tool_result`) as
   authoritative and durable. That line is correct and it resolves the renderer (below).
2. **Ack steers explicitly.** It emits `input_ack` when a mid-turn steer was actually pushed
   into the live session. A queued item should leave the UI because the engine took it, not
   because we hoped it did.

---

## Layering

One rule: **arrows point inward. `ui` depends on everything, `domain` depends on nothing.**

```
  ui/          Ink components, pages, hooks         ← may import anything below
  app/         turn runner, steer queue, rotation   ← orchestration; no React
  store/       repositories over Prisma             ← no React, no engine
  auth/        credentials, OAuth, engine homes     ← no React, no engine
  engine/      ClaudeEngine + normalise()           ← no React, no Prisma
  domain/      types, role→engine table, pure rules ← imports NOTHING
```

`app/` is the only layer allowed to touch both `store/` and `engine/`. That keeps the turn
runner testable with two fakes and no React — which matters, because the turn runner is where
every interesting bug will live.

---

## Folder structure

```
tui/
  package.json                  @dltech/atlas-harness — codex-sdk its only workspace dep
  tsconfig.json
  prisma/
    schema.prisma
    migrations/                 generated, committed
  src/
    main.tsx                    argv → boot Nest context → resolve → render <App/>
    app.module.ts               the root module — imports the five feature modules

    domain/                     pure functions. no I/O, no DI, no imports from other layers.
      role-engine.ts            EThreadRole → EEngine table
      message.ts                the normalised payload union
      seam.ts                   derive session seams from a message list
      truncate.ts               "… +N lines" rules
      trail.ts                  breadcrumb segments fitted to the width available
      list-nav.ts               selection clamping + the filter predicate
      viewport.ts               scroll geometry — offset counts up from the bottom
      text-editor.ts            the composer buffer: text + cursor, every edit a transition
      editor-keymap.ts          key chord → edit command (what each terminal actually sends)
      editor.ts                 one key against the buffer + whether it was consumed
      composer-layout.ts        wrap + caret placement + windowing
      paths.ts                  ~/.atlas layout — the one place paths are built
      semver.ts                 version compare for /doctor

    store/
      store.module.ts           @Global — every layer above needs repositories
      prisma.service.ts         PrismaClient + better-sqlite3 adapter, OnModuleDestroy
      pragmas.ts                WAL + busy_timeout, applied on every connection
      migrator.service.ts       startup auto-migration, BEGIN IMMEDIATE
      account.repository.ts
      project.repository.ts
      job.repository.ts
      thread.repository.ts
      session.repository.ts
      message.repository.ts

    auth/
      auth.module.ts
      secret-cipher.service.ts  AES-256-GCM over ~/.atlas/key (0600)
      account-vault.service.ts  decrypt on read, encrypt on write
      engine-home.service.ts    write active account material into the engine home
      oauth/
        claude-oauth.client.ts  PKCE + paste-back code
        codex-oauth.client.ts   device code                      (v1.1)

    engine/
      engine.module.ts
      claude-engine.service.ts  concrete. calls sdk.query(). no interface.
      codex-engine.service.ts   concrete. wraps CodexClient.     (v1.1)
      claude-sdk.provider.ts    the SDK itself as a token — swappable in tests
      normalise/
        claude-normaliser.service.ts   Claude SDK event → domain payload
        codex-normaliser.service.ts    CodexEvent → domain payload    (v1.1)
      raw-tape.service.ts       append-only JSONL per session
      version-check.service.ts  codex --version + daily npm check, never blocks

    app/
      app-services.module.ts
      turn-runner.service.ts    run a turn: engine → events → store + sink
      steer-queue.service.ts    queue, boundary delivery, interrupt
      session-manager.service.ts  open / resume / rotate an EngineSession
      account-rotator.service.ts  pick an account, swap credential at a turn boundary
      context-folder.service.ts   per-job dir, three buckets, path jail
      turn-store.ts             the useSyncExternalStore-backed live-turn snapshot

    ui/
      app.tsx                   which page is mounted + the two global keys
      navigation.ts             the route stack — push / pop / replace / toggle
      theme.ts                  the one accent colour, dim, red
      pages/
        projects.tsx  jobs.tsx  conversation.tsx
        accounts.tsx  help.tsx  doctor.tsx
        context.tsx   threads.tsx  step.tsx  transcript.tsx
      components/
        screen.tsx                header pinned top, footer pinned bottom, body clips
        scroll-region.tsx         the bottom-anchored transcript viewport
        page-header.tsx           the trail every page draws; breadcrumb delegates to it
        confirm-bar.tsx           the destructive-action prompt, in the footer
        breadcrumb.tsx  composer.tsx  hint-line.tsx
        usage-meters.tsx          ctx / 5h / wk + account chip
        overlay-list.tsx          opens upward
        working-line.tsx          spinner + elapsed + queued items
        blocks/                   the message grammar, one file per glyph
          user-block.tsx  assistant-block.tsx
          tool-block.tsx  thinking-block.tsx  error-block.tsx
      terminal/
        alt-screen.ts             enter/restore the alternate buffer
      hooks/
        use-terminal-size.ts      rows/columns, resubscribed on resize
        use-turn.ts  use-steer-queue.ts  use-key-map.ts
```

Naming follows the backend's `<name>.<type>.ts` convention where a type exists
(`*.repository.ts`), plain kebab otherwise. React files `.tsx`, everything else `.ts`.

Per the v1 cut line in the wireframes, `pages/context.tsx`, `threads.tsx`, `step.tsx`,
`transcript.tsx` and `doctor.tsx` are deferred — listed so the shape is visible, not so they get
written. Files marked `(v1.1)` are the Codex half.

`auth/` is its own top level rather than living under `engine/`. Credentials outlive any one
engine session and are read by `app/account-rotator.ts` as well as the engines, so filing them
under `engine/` would invert the dependency the moment rotation exists.

---

## The delta/authoritative rule

The single most useful rule in the whole design, because **persistence and rendering follow
it together**:

| SDK event | Renders to | Persists to |
|---|---|---|
| text / thinking **deltas** | live tail (re-renders) | nothing |
| text / thinking / tool_use / tool_result **blocks** | transcript viewport | `ThreadMessage` |
| session id known | breadcrumb | `EngineSession.engineSessionId` |
| steer ack | removes a queued item | nothing |
| usage / context breakdown | `ctx %` in the hint line | nothing |
| rate limit | `5h` / `wk` meters | the running `Account` row |
| *everything* | nothing | `raw.jsonl` |

Deltas are a live view of a block being built; the block is the truth. Persist the truth,
render the view. One rule, and the tail-vs-transcript question answers itself.

---

## Accounts, auth, and rotation

**Atlas owns auth.** It holds multiple Claude accounts (and Codex accounts), picks one per
session, and rotates to another when one hits its usage wall. This is the feature that makes
a local harness better than running `claude` directly.

### What exists in the web, and what doesn't

The cloud harness already has **multi-account storage and manual selection** — an
`agent_credentials` row per account with `selected`, `usageSnapshot`, `materialEnc`, and a
working Claude OAuth client (`host/agent-credentials/oauth/claude-oauth.client.ts`: PKCE with
a manual paste-back redirect) plus a Codex device-code client.

It does **not** have auto-rotation. `agent-credential-resolver.service.ts` is 51 lines —
`resolve()` and `envForTurn()` — and simply returns the selected credential. On a limit the
cloud parks the lane and schedules an auto-resume at `resetAt`. **Rotation is new work**, not
a port. Budget accordingly.

Port the OAuth flows (~100 lines each, mostly PKCE and an HTTP round-trip); do not import
them.

### Schema

```prisma
enum EAccountStatus {
  active
  limited
  expired
  revoked
}

model Account {
  id               String         @id @default(uuid())
  engine           EEngine
  label            String
  accountEmail     String?
  subscriptionType String?
  status           EAccountStatus @default(active)

  materialEnc      String         // AES-256-GCM, see below
  expiresAt        DateTime?
  lastRefreshedAt  DateTime?

  fiveHourUtil     Float?         // per-account usage — what the footer meters read
  fiveHourResetsAt DateTime?
  sevenDayUtil     Float?
  sevenDayResetsAt DateTime?
  usageFetchedAt   DateTime?

  sessions         EngineSession[]
  createdAt        DateTime       @default(now())

  @@unique([engine, accountEmail])
}
```

`EngineSession` gains `accountId` — **which account actually ran this session**, for the same
reason it stores `engine`: history must stay truthful when policy changes. `ESessionEndReason`
gains `usage_limit`.

Usage lives here rather than in a file: it is **per-account, not per-engine**, matching the
web where `usageSnapshot` sits on the credential row. An earlier draft put it in
`~/.atlas/usage.json` purely because no account row existed yet — that file is not part of the
design.

### Rotation does not lose context

An earlier draft of this doc claimed account rotation forces a new session. **That was wrong.**

The Anthropic API is **stateless** — every turn resends the whole message history. A "session"
is a local transcript file plus an id to resume it by; it is not server-side state tied to a
credential. Auth is therefore a **per-turn** concern. Starting the next turn with a different
token and the same `resume` id continues the same conversation with the same context.

So rotation is transparent: same `EngineSession`, same `engineSessionId`, same transcript,
same scroll. Only the credential on the next turn differs.

**The real cost is the prompt cache**, which is keyed per account. Rotating invalidates it, so
the first turn on the new account re-reads the full context at uncached input price. That is a
bill, not a loss of memory — and it is the reason to rotate at a natural boundary rather than
ping-pong between accounts.

### Isolate credentials, share session storage

The corollary, and the thing to get right: **whatever isolates accounts must not also isolate
transcripts.** Per-account home directories fail this on both engines.

- **Claude.** The transcript lives under the config dir (`~/.claude` by default), keyed by
  cwd. Give each account its own config dir and sessions fragment — account B cannot resume a
  session account A started. **Inject the credential via the environment instead and keep one
  config dir.** That is not just simpler; it is what makes rotation possible at all.
- **Codex.** `CodexClientOptions.codexHome` is passed straight through as `CODEX_HOME`, which
  holds `auth.json` **and** session/rollout storage. Per-account `CODEX_HOME` fragments Codex
  threads exactly the same way. Use **one shared** `~/.atlas/codex-home/`, keep account
  material at `~/.atlas/accounts/<id>/auth.json`, and write the active account's `auth.json`
  into the shared home before starting a turn. Turns run in parallel, so that write is serialised
  against the spawn — see "Parallel turns" below.

### Agent homes are Atlas-owned

**Agent homes live under `~/.atlas/`, and Atlas owns them outright.** It does not read, merge
with, or respect the user's personal `~/.claude` or `~/.codex` — those are a different tool's
state. Atlas writes its own homes and **overwrites their contents freely**, which is what makes
"swap the active account's `auth.json` before a turn" a safe operation rather than a
destructive one.

```
~/.atlas/
  accounts/<accountId>/auth.json     per-account material (encrypted at rest)
  claude-home/                       ONE Atlas-owned Claude config dir
  codex-home/                        ONE Atlas-owned CODEX_HOME — sessions live here
```

One home per engine, not per account. Accounts are credentials; homes are session storage, and
conflating them breaks rotation (above).

**Still to verify:** the exact Claude credential-injection mechanism against the installed SDK
— env var vs config dir. The *shape* is settled (Atlas-owned home, credential swapped per
turn); the variable name should be confirmed rather than assumed.

---

## Parallel turns

**Threads run in parallel; the turns inside one thread do not.** A conversation is a sequence — two
overlapping turns would interleave two sets of frames into one transcript — but two *different*
threads share nothing that needs serialising.

### Nothing in the SDK required the old behaviour

`sdk.query()` spawns a Claude Code **subprocess** per call, and `Options.env` replaces that
subprocess's environment wholesale. Every query is therefore an isolated OS process with its own
environment and its own `resume` id. The one-turn-at-a-time behaviour was three singletons Atlas
wrote, each holding one turn's worth of state:

| Was | Now |
|---|---|
| `ClaudeEngineService` held `input` / `handle` / `interrupted` — a second `run()` overwrote them, so turn A's `interrupt()` reached turn B's query | `start()` returns a `RunningTurn` that owns them. The service is a stateless factory |
| `TurnRunnerService.queueTurn` awaited the previous turn, globally | One `Lane` per thread: `inFlight`, `chain`, `preflight`, `contextPercent`, `turn`. Queueing is per-lane |
| One `ConversationStore` for "the" conversation | `ConversationStoreRegistry.for(threadId)` — one store per thread |

That last one was not just a limitation, it was a **live bug**: leaving a running job and opening
another called `reset()` on the shared store while the first job's turn kept writing into it, so
job A's assistant blocks rendered inside job B's transcript. The rows were always correct — they
are keyed by thread — so reopening A showed the truth. On-screen corruption that nothing about the
screen flags as wrong is worse than a crash.

`enqueue()`'s one-write-at-a-time chain is now **per thread**, which is exactly right: the UNIQUE
constraint it protects is `(threadId, ordinal)`, so two threads writing at once was never the race.

### Re-entering a running thread

Opening a thread calls `hydrate()`, not `reset()`. `reset()` blanks everything, which is correct
for a fresh open and wrong for one whose turn is still running — it would clear the spinner, the
live tail and the steer queue, making a working agent look idle. `hydrate()` replaces only the
durable half, and keeps any message committed between the caller's read and the call, because the
read is a snapshot and a turn does not pause for the UI.

### Credentials are the part that had to change

`prepareClaudeHome` wrote one shared `~/.atlas/claude-home/.credentials.json` before every turn.
Its own comment said why that was safe — "the TUI runs one turn at a time, so there is no race" —
and that sentence stopped being true. Two concurrent turns on different accounts would have raced
one file, and the failure is the bad kind: not a crash, but a turn silently billed to the wrong
account.

The fix is that **auth rides the per-turn env**. `CLAUDE_CODE_OAUTH_TOKEN` is one of the SDK's auth
sources and is consulted before the fallback that looks for stored credentials, and `env` is
per-`query()` — so it is genuinely per-turn where a file in a shared directory can never be. That
also settles the "env var vs config dir" question this doc had left open under *Agent homes are
Atlas-owned*: **both**, and they carry different halves. `CLAUDE_CONFIG_DIR` still points at the one
shared home, because session and transcript storage *must* be shared or rotation breaks.

The credential file is still written, and `EngineHomeService.claim()` still holds a mutex across
write-then-spawn. Belt and braces: the env var should be what authenticates, and if it somehow is
not, the mutex guarantees no other turn rewrote the file in between. **Worth confirming with one
real two-account parallel run** — that is the single unverified assumption in this section.

### What the UI owes a background agent

An agent working in a job you are not looking at has to be visible, or leaving one running is
indistinguishable from not having started it:

- `TurnRunnerService` exposes `subscribe` / `getRunningThreadIds` for `useSyncExternalStore`. The
  snapshot is cached and only replaced when the set actually changes, or the hook loops forever.
- The jobs list draws a spinner in place of the status dot and reads `working…`, and re-reads the
  list when the running set changes so `updatedAt` does not go stale.
- `ctrl+c` names how many turns are in flight and quits on the second press. Turns are subprocesses
  of this process, so quitting does kill them.

Two loose ends, both accepted knowingly. Quitting releases only the *open* session's soft lock, so a
background thread's lock is left behind and clears itself after `LOCK_STALE_MS`. And deleting a job
asks the runner whether any of its threads are running rather than whether the job is open, because
a job no longer has to be on screen to be working.

---

## Startup: migrate, then run

The TUI applies pending migrations **on every start**, against `~/.atlas/atlas.db`. No manual
`db:migrate` step for the user — the binary is self-installing.

Prisma has no supported programmatic migrate API, and shipping the Prisma CLI just to run
`migrate deploy` is a bad trade for a CLI app. So:

1. `prisma migrate dev` at **authoring** time generates `prisma/migrations/*/migration.sql`.
   Those files are committed and bundled.
2. At **startup**, read them in order, compare against an applied-migrations table, and run the
   unapplied ones with better-sqlite3 directly. ~50 lines, no CLI dependency at runtime.

Greenfield means a failed migration is recoverable by deleting the DB, so the boot path can
fail loudly rather than attempting repair.

## Deletion

A job and a project both delete, and they are **different kinds of act** — which is the whole
reason the two confirms read differently.

- **A project row is a bookkeeping entry.** `path` points at the user's own repository, so
  removing the row must never be able to touch a folder. Nothing under `deleteProject` calls
  `rmSync` on anything outside `~/.atlas`, and the confirm says "the folder on disk is untouched"
  because "remove" next to a path is otherwise a frightening word.
- **A job is real destruction.** Transcript, threads, sessions and the job's `/context` folder,
  with no archive state and no undo.

Three things have to happen in order, and the order is load-bearing:

1. **Evict.** `ConversationService.evict(jobIds)` refuses while a turn is running into one of
   them — the turn holds `threadId`/`sessionId` in flight and would write against a row that no
   longer exists — and otherwise drops the soft lock.
2. **Read the tape keys.** `engineSessionIdsFor(jobId)` runs **before** the delete. Afterwards
   there is nothing left to ask, and the tapes become unreachable files nobody will ever remove.
3. **Delete, then purge.** Rows go by `ON DELETE CASCADE`, which is real here: the Bun SQLite
   adapter issues `PRAGMA foreign_keys = ON` on every connection it opens (SQLite leaves
   enforcement off by default, and Prisma does not emulate cascades unless `relationMode` is
   `"prisma"` — so this is worth knowing rather than assuming). The files the database cannot
   reach — `~/.atlas/jobs/<jobId>` and `~/.atlas/sessions/<engineSessionId>` — are removed with
   `force: true`, because a job that never ran has neither and that is not a failure.

Verified end to end against the real database: create a project and a job, delete the project,
and every table count returns to exactly what it was, the job directory is gone, and the probe
folder on disk is still there.

## Staying current with Claude and Codex

**Atlas extends these tools; it does not replace them.** That is a design constraint, not a
slogan, and it has a concrete implication that matters more than any version check:

> **Keep the SDK surface tiny.** `normalise()` is the only place SDK types are touched, and
> `ClaudeEngine` / `CodexEngine` are the only places SDK calls are made. Never reimplement
> what the SDK does, never fork its behaviour, never mirror its types into `domain/`.

A thin adapter *is* the update strategy. When the SDK moves, the blast radius is two files and
one test fixture. Everything else in the app is written against the domain union and does not
care. Staleness detection is the cheap part; keeping upgrades cheap is the real work.

### The two dependencies are opposite problems

| | Claude | Codex |
|---|---|---|
| Shape | npm dependency, we resolve it | external binary, the user owns it |
| Today | `@anthropic-ai/claude-agent-sdk` — backend has `^0.3.204`, npm latest `0.3.220` | `codex-cli 0.142.5` on PATH |
| Risk | **we** fall behind upstream | **theirs** is older than our protocol assumptions |
| Detect | installed version vs registry | `codex --version` |
| Fix | bump and rebuild | tell them the upgrade command |

### Codex — check the binary

`codex-sdk` spawns `codex app-server`, so the protocol contract is with a binary Atlas does not
control. Check it at first use per process and cache the result:

- `codex --version` → `codex-cli 0.142.5`. Parse, compare against a declared
  `MIN_CODEX_VERSION`.
- **Below minimum** → warn, name the upgrade command, and keep going. The turn may still work.
- **Binary missing** → Codex accounts are unusable. Surface that on the Accounts page as an
  engine-level condition, don't crash and don't discover it mid-turn.
- **Newer than tested** → say nothing. Blocking on a version being *too new* is user-hostile
  and is wrong more often than it is right.

### Claude — check the registry, quietly

The installed version is readable locally from the package. Compare against
`registry.npmjs.org` **at most once a day**, cached in `~/.atlas/version-check.json`.

Non-negotiables: it runs in the background, it **never blocks a turn**, and it **fails silently
offline**. A version check that makes a plane-mode session worse has negative value.

### `/doctor`

One command that answers "is my setup current and working" — versions, staleness, binary
presence, DB path, account health. It is the honest place for this, because the alternative is
a nag in the footer that either gets ignored or gets annoying.

A passive nudge earns its place only when something is *actually* stale, and then it is one dim
line, dismissible, shown once per day at most.

---

## Multi-instance

Several TUIs will be open at once — that is normal, not an edge case.

**Required pragmas on every connection:**

```sql
PRAGMA journal_mode = WAL;    -- concurrent readers alongside one writer
PRAGMA busy_timeout = 5000;   -- block instead of throwing SQLITE_BUSY
```

`busy_timeout` is the one that is easy to forget and produces intermittent, confusing failures
under exactly the conditions that are hardest to reproduce.

**Migration is the dangerous moment** — two instances starting together must not both migrate.
Wrap the whole check-and-apply in a single `BEGIN IMMEDIATE` transaction: SQLite grants the
write lock to one instance, the other blocks, and by the time it proceeds the migrations are
already recorded as applied. No lock file, no coordination protocol.

**Open questions the implementation has to answer:**

- **Two instances on the same thread.** Both could run a turn into one conversation. Simplest
  answer is a soft lock — an `EngineSession.lockedBy` (pid + started-at, stale after N seconds)
  — with the second instance opening read-only and saying so.
- **Cross-instance freshness.** Instance A does not see B's writes without polling. Tolerable
  when they are on different jobs; visibly wrong when on the same one. A cheap fix is polling
  `Job.updatedAt` on the pages that list things, and leaving the conversation view alone since
  it is authoritative for its own turn.

### Encryption at rest

AES-256-GCM via `node:crypto`, key at `~/.atlas/key` mode `0600`. No dependency, portable.

Be honest about what that buys: it protects against **casual disclosure** — dotfile sync,
backups, screen sharing, a shoulder-surfed `cat`. It does **not** protect against anything
running as your uid, since that can read the key too. The OS keychain would, at the cost of
platform-specific code on every OS. Given Claude Code itself keeps `~/.claude/.credentials.json`
on disk, the file-key approach is not a regression.

### Rotation policy

On a limit signal (`rate_limit` frame, or a turn ending on a session-limit):

1. Mark the account `limited`, record `resetsAt`.
2. Pick the next account: same engine, `active`, most headroom on the 5-hour window.
3. Swap the credential. **Nothing else changes** — same session, same transcript, next turn.
4. If none is available, park and count down to the earliest `resetsAt`.

`EngineSession.accountId` therefore means *the account currently running it*, and is updated
in place on rotation — a session can outlive several accounts. Per-turn account attribution is
not modelled; usage comes off `rate_limit` frames directly, so nothing needs it. If
per-account token accounting is ever wanted, that is the change to make.

**Rotate at a turn boundary, not mid-turn.** When the active account crosses ~95% and another
has headroom, swap before starting the next turn rather than letting a turn die halfway.
Hitting the wall mid-turn still has to work — it should just be the uncommon path.

---

## Usage meters

The hint line carries `5h` and `wk` — the two subscription windows the web composer shows.
Local shape, declared here rather than imported:

```ts
type UsageWindow = { utilization: number; resetsAt: string } | null
type EngineUsage = { fiveHour: UsageWindow; sevenDay: UsageWindow; fetchedAt: number }
```

Stored on `Account`, not in a file — see Accounts above. Windows are per-account, so the
meters always describe the account currently running.

**Harvest first, poll second.** The web merges `rate_limit_event` frames off the turn stream
with a `/api/oauth/usage` HTTP poll. Harvest is free and needs no extra plumbing, so build it
first; but note the poll matters more here than it did before rotation existed, because
**rotation needs to know about accounts that are not currently running.** Harvest only ever
teaches you about the active one, so a rotation target's headroom is stale until you switch to
it. Harvest is enough to react to a limit; the poll is what makes rotation *choose well*.

Known trap when the poll gets built: setup-token credentials lack the `user:profile` scope, so
`/api/oauth/usage` 403s for them. Personal OAuth logins are fine.

`null` windows render `—`, never `0%` — an unknown account is not an idle one.

---

## State and re-render strategy

Token deltas arrive far faster than a terminal should repaint. Two structural mitigations:

1. **A tiny store read through `useSyncExternalStore`** — no Context, no provider cascade.
   Each component subscribes to the slice it needs, so a text delta re-renders the live tail
   and nothing else. Zero dependencies.
2. **Coalesce deltas on a frame timer** (~30fps). Deltas append to a buffer; the store
   notifies on a tick. Token-rate repaints are invisible anyway and cost real CPU.

Not RTK — its wins (devtools, entity adapters, RTK Query) are browser wins; in a terminal it
is weight without payoff. `web/` staying on RTK is correct and unaffected.

---

## The screen: alternate buffer, Atlas-owned scrolling

*(Revised 2026-08-02. This section previously specified Ink's `<Static>` and ruled out
alt-screen; see `tui-wireframes.md` → "Resolved: scrollback ownership" for why that reversed
and what it costs.)*

`main.tsx` enters the **alternate screen buffer** (`ESC[?1049h`) before the first render and
restores it on every exit path — clean return, signal, uncaught throw. That restore is the
whole risk: a process that dies without emitting `ESC[?1049l` hands back a terminal with a
hidden cursor and no scrollback, which reads as a broken machine. `alt-screen.ts` is therefore
idempotent and registered on `exit` plus `SIGINT`/`SIGTERM`/`SIGHUP`.

The container boots **before** entering the buffer, so a migration that throws prints its stack
to the user's real terminal instead of into a buffer discarded milliseconds later.

Layout is three components deep:

- **`App`** is the only component that reads `rows`/`columns`, and pins the root frame to
  exactly the terminal size. Ink notices `outputHeight >= stdout.rows` and drops the trailing
  newline it would otherwise append, which is what stops the frame scrolling by one line per
  render.
- **`Screen`** is one page's chrome: header pinned top, footer pinned bottom, body taking the
  rest and clipping.
- **`ScrollRegion`** is the transcript's window. `justifyContent="flex-end"` packs content
  against the bottom, so *sticking to the newest output is the default state* rather than
  something maintained on every append; a **negative** `marginBottom` slides content back down
  to reveal history. `measureElement` supplies the two heights needed to clamp the offset.

**`flexBasis={0}` on every growing box and `flexShrink={0}` on chrome is load-bearing.** Yoga
otherwise takes the body's flex basis from its own content — hundreds of transcript lines —
distributes the overflow proportionally, and crushes a one-line footer to **zero height**. The
composer silently disappears, and only on long transcripts: precisely the case nobody catches
by hand. `full-screen.spec.tsx` pins this with a 200-line body.

Scroll geometry lives in `domain/viewport.ts` as pure functions. The offset counts lines **up
from the bottom**, which makes "follow the tail" the zero case; the price is
`followContentGrowth`, which nudges a scrolled-up reader's offset by however many lines just
arrived so output landing below them does not drag their view along.

---

## The composer is a real editor

Four pure modules under `domain/`, so the whole thing is testable without a terminal:

- **`text-editor.ts`** — `{ text, cursor, goalColumn }` and every edit as a transition. The
  cursor is a flat index; row and column are derived, so an edit can never leave the two halves
  of the position disagreeing. `goalColumn` is the one non-derivable bit: moving down through a
  short line and back must return to the ORIGINAL column.
- **`editor-keymap.ts`** — chord → command, and the record of what each terminal actually sends.
- **`editor.ts`** — `applyKey(state, input, key) → { next, consumed }`.
- **`composer-layout.ts`** — wrapping, caret placement, and windowing to `MAX_ROWS`.

**`consumed` is the arbitration rule between editing and scrolling**, and it is why `applyKey`
is a pure function rather than logic inside the hook. React does not run `setState` updaters
synchronously, so a flag assigned inside an updater is still false when the handler returns —
which would have inverted the rule silently while the edit still applied. The hook keeps a ref
mirroring state so the answer is available immediately.

Wrapping is done in `composer-layout.ts` rather than left to Ink's `<Text>`. Ink would fold the
string correctly, but the caret is drawn by splitting that string at the cursor, and a split
computed against unwrapped text lands in the wrong place as soon as a line folds. Cursor
movement stays on **logical** lines — the same choice vim makes, and what keeps `text-editor.ts`
independent of terminal width.

The caret is inverse video over the character it sits on, because the terminal's own cursor is
hidden in the alternate buffer. Note for tests: chalk decides at import time whether a stream
supports colour and a fake stdout says no, which strips the caret — hence `FORCE_COLOR` in
`vitest.config.ts`.

---

## Composition: NestJS standalone

`main.tsx` parses argv, boots a **standalone Nest application context**
(`NestFactory.createApplicationContext`), resolves the root services, and hands them to `<App/>`.
No HTTP adapter, no controllers — the container is used purely as a DI graph.

**This reverses an earlier decision in this doc.** The original argument was "a CLI pays framework
boot on every invocation". That is true of `git status`; it is not true of this. The TUI is a
long-lived interactive process — you launch it once and sit in it — so container boot is paid a
single time and amortises to nothing. **Measured: 4 ms** to build the context under
`@swc-node/register`, against a process that lives for hours.

With that objection gone, the house default wins on its merits: the turn runner alone has five
collaborators, and module boundaries + `overrideProvider` in tests are exactly what this shape
wants. It also keeps the TUI consistent with the rest of the repo.

**Runner consequence — this is the load-bearing detail.** NestJS needs `emitDecoratorMetadata`
to reflect constructor parameter types, and **esbuild does not implement it**. That rules out
`tsx` (and vitest's default transform), and it fails *silently*: decorators still compile, so
every container-resolved dependency simply arrives `undefined` at runtime instead of erroring at
build time. So:

- **Runtime:** `node --import @swc-node/register/esm-register src/main.tsx`
- **Tests:** `unplugin-swc`'s `swc.vite()` plugin, reading `.swcrc` — same as `backend/`
- `.swcrc` sets `legacyDecorator` + `decoratorMetadata`, and `jsc.transform.react.runtime`
  `automatic` for Ink's JSX

Verified end to end: Nest resolves a two-level graph with no explicit `@Inject`, and Ink renders
a live tail driven by a container-provided service, both under that runner. (The original smoke
test used `<Static>`, which the alternate-buffer decision has since removed.)

### What is and isn't a provider

`domain/` stays **plain pure functions** and is the one deliberate exception to the house "no
loose exported functions" rule. Those functions have zero collaborators and are called directly
from React render paths, which cannot inject. Making them services would buy nothing and cost a
container lookup in the render loop.

Everything with a dependency — repositories, engines, the turn runner, the steer queue, the
session manager, the account vault — is an `@Injectable` in a module, per house style.

Consistent with **no speculative ports** — v1 has no ports at all. Repositories and
`ClaudeEngine` are concrete classes, registered and injected as themselves.

---

## Prisma and migrations

```
tui/prisma/schema/              the local schema — shares nothing with backend's
  schema.prisma                 generator + datasource ONLY (allowed once across the folder)
  account.prisma                one file per src/store repository; enums live with the models
  project.prisma                that use them
  job.prisma                    (Job + ThreadGroup)
  thread.prisma
  session.prisma
  message.prisma
tui/prisma/migrations/          generated, committed
tui/src/generated/prisma        client output, matching backend's convention
```

- The schema is a **multi-file schema**: `prisma.config.ts` points `schema` at the *directory*, and
  the CLI concatenates every `.prisma` file in it. Adding a file needs no config change; adding a
  second `generator`/`datasource` block anywhere in the folder is an error.
- `migrations.path` is pinned in `prisma.config.ts` so migrations stay at `prisma/migrations`
  rather than moving under the schema folder — `scripts/embed-migrations.ts` reads that path.

- `pnpm --filter @dltech/atlas-harness db:migrate` → `prisma migrate dev`, which **generates** the
  SQL. Never hand-write a migration. This is an *authoring-time* command; users never run it
  (see Startup above).
- Greenfield means `migrate reset` is always available, so no schema change ever needs to
  preserve data.
- `prisma.config.ts` needs **`datasource.url`** and takes **no `adapter`** (no such field on
  `PrismaConfig` 7.9.1); the runtime adapter is built in `PrismaService`
  (`@prisma/adapter-better-sqlite3`).

---

## Dependencies

Deliberately short:

```
ink  react  @prisma/client  @prisma/adapter-better-sqlite3
@anthropic-ai/claude-agent-sdk     vendor SDK — Claude, spawns a Claude Code subprocess
@workspace/codex-sdk               vendor SDK — Codex, spawns `codex app-server`
dev: prisma  typescript  tsx  tsup  vitest  ink-testing-library
```

Two vendor SDKs, zero harness dependencies. That is the whole dependency story.

`better-sqlite3` is already in the root `allowBuilds` allowlist, so the native build will not
need a workspace change.

---

## Testing

Vitest, per house preference.

| Layer | How |
|---|---|
| `domain/` | plain unit tests; it is all pure functions |
| `engine/normalise.ts` | table-driven: SDK event in, domain payload out. **The highest-value tests here** — and the file most likely to become shared code |
| `app/turn-runner.ts` | fake engine emitting a scripted event sequence + in-memory repos |
| `app/steer-queue.ts` | boundary delivery, interrupt, ack |
| `ui/` | `ink-testing-library` frame snapshots, one per wireframe state |

Build the scripted turn as a shared fixture — text → thinking → tool → result → text. It is
the regression net for the renderer now, and when Codex lands, replaying the same fixture
through both `normalise()` implementations and asserting identical domain output is what
proves the abstraction.

---

## Open

- **Repo placement** — `tui/` here, or its own repo? Assumed here; trivially reversible.
- **Claude SDK options.** `_shared_old/engine/engine-core/claude-options-builder.ts` (216
  lines) builds them for the cloud. Worth reading for what the local set *doesn't* need
  rather than porting.
- **When to revisit `agent-engine`.** Once the TUI runs and a second engine is wanted, diff
  the two designs. The convergence point is `normalise()` plus whatever `run()` signature
  both ended up needing.
