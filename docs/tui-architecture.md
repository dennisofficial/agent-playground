# Local Atlas TUI — code architecture

Companion to `docs/tui-wireframes.md`. What gets built, where it lives, and which way the
dependencies point.

## Standalone

**Fully standalone.** Own schema, own types, own engine wiring, own turn loop. It imports
nothing from `shared`, nothing from `agent-engine`, nothing from `backend/`. Every type it
needs, it declares.

That includes the phase and role vocabulary. Restating nine enum members is cheaper than
adopting `shared`'s, which is stale anyway — `EThreadGroupKind` there has no `intake` and no
`design` and still carries `direct_build` / `plan_review`, the exact drift
`orchestration-shapes.md` lists as open and the orchestration chat is rewriting now.

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
binary must be installed and authenticated (`codexHome`). Claude runs in-process; Codex does
not. That asymmetry is real and belongs in the engine layer, not leaking upward.

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
two clients are shaped differently enough to make the point: Claude runs in-process with a
streaming input generator and `interrupt()` on the query handle; Codex spawns a child process
and takes explicit `(threadId, turnId)` on `steer` and `interrupt`. An interface guessed from
only the first would have missed that.

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
  app/         turn runner, steer queue, services   ← orchestration; no React
  store/       repositories over Prisma             ← no React, no engine
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
  package.json                  @workspace/tui — codex-sdk its only workspace dep
  tsconfig.json
  prisma/
    schema.prisma
    migrations/                 generated, committed
  src/
    main.tsx                    argv → boot → render <App/>
    composition.ts              THE composition root — everything constructed here

    domain/                     pure. no I/O, no imports from other layers.
      role-engine.ts            EThreadRole → EEngine table
      message.ts                the normalised payload union
      seam.ts                   derive session seams from a message list
      truncate.ts               "… +N lines" rules
      paths.ts                  ~/.atlas layout

    store/
      client.ts                 PrismaClient + better-sqlite3 adapter, WAL on connect
      project.repository.ts
      job.repository.ts
      thread.repository.ts
      session.repository.ts
      message.repository.ts

    engine/
      claude-engine.ts          concrete. calls sdk.query(). no interface.
      codex-engine.ts           concrete. wraps CodexClient. (v1.1)
      normalise/
        claude.ts               Claude SDK event → domain payload
        codex.ts                CodexEvent → domain payload      (v1.1)
      raw-tape.ts               append-only JSONL per session

    app/
      turn-runner.ts            run a turn: engine → events → store + sink
      steer-queue.ts            queue, boundary delivery, interrupt
      session-manager.ts        open / resume / rotate an EngineSession
      context-folder.ts         per-job dir, three buckets, path jail
      usage-store.ts            5h/weekly windows — harvested, JSON-backed

    ui/
      app.tsx                   which page is mounted
      theme.ts                  the one accent colour, dim, red
      pages/
        projects.tsx  jobs.tsx  conversation.tsx
        context.tsx   threads.tsx  step.tsx  transcript.tsx
      components/
        breadcrumb.tsx  composer.tsx  hint-line.tsx
        overlay-list.tsx          opens upward
        working-line.tsx          spinner + elapsed + queued items
        blocks/                   the message grammar, one file per glyph
          user-block.tsx  assistant-block.tsx
          tool-block.tsx  thinking-block.tsx  error-block.tsx
      hooks/
        use-turn.ts  use-steer-queue.ts  use-key-map.ts
```

Naming follows the backend's `<name>.<type>.ts` convention where a type exists
(`*.repository.ts`), plain kebab otherwise. React files `.tsx`, everything else `.ts`.

Per the v1 cut line in the wireframes, `pages/context.tsx`, `threads.tsx`, `step.tsx`, and
`transcript.tsx` are deferred — listed so the shape is visible, not so they get written.

---

## The delta/authoritative rule

The single most useful rule in the whole design, because **persistence and rendering follow
it together**:

| SDK event | Renders to | Persists to |
|---|---|---|
| text / thinking **deltas** | live tail (re-renders) | nothing |
| text / thinking / tool_use / tool_result **blocks** | `<Static>` (committed) | `ThreadMessage` |
| session id known | breadcrumb | `EngineSession.engineSessionId` |
| steer ack | removes a queued item | nothing |
| usage / context breakdown | `ctx %` in the hint line | nothing |
| rate limit | `5h` / `wk` meters | `~/.atlas/usage.json`, keyed by engine |
| *everything* | nothing | `raw.jsonl` |

Deltas are a live view of a block being built; the block is the truth. Persist the truth,
render the view. One rule, and the Static-vs-live-tail question answers itself.

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

  fiveHourUtil     Float?         // per-account usage — supersedes usage.json
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

This **supersedes `~/.atlas/usage.json`.** That file existed because there was no row to hang
usage on. Now there is one, and usage is per-account rather than per-engine — matching the
web, where `usageSnapshot` lives on the credential row.

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
  into the shared home before starting a turn. The TUI runs one turn at a time, so there is no
  race.

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

Finished blocks go into an array rendered by Ink's `<Static>`, which prints each item once to
real scrollback and never re-renders it. That is what preserves native scroll and copy.

---

## Composition, not a container

`main.tsx` parses argv; `composition.ts` constructs everything once and hands it to `<App/>`.
Constructor injection throughout, no framework.

Not NestJS, despite it being the house default: a CLI pays framework boot on every
invocation, there is no HTTP lifecycle to manage, and React already owns the UI lifecycle.
DI's real win is swappable collaborators in tests, and constructor injection delivers that
without a container.

Consistent with **no speculative ports** — v1 has no ports at all. Repositories and
`ClaudeEngine` are concrete classes injected directly.

---

## Prisma and migrations

```
tui/prisma/schema.prisma        the local schema — shares nothing with backend's
tui/prisma/migrations/          generated, committed
tui/src/generated/prisma        client output, matching backend's convention
```

- `pnpm --filter @workspace/tui db:migrate` → `prisma migrate dev`, which **generates** the
  SQL. Never hand-write a migration. This is an *authoring-time* command; users never run it
  (see Startup above).
- Greenfield means `migrate reset` is always available, so no schema change ever needs to
  preserve data.
- `prisma.config.ts` needs **both** `datasource.url` and `adapter`
  (`@prisma/adapter-better-sqlite3`).

---

## Dependencies

Deliberately short:

```
ink  react  @prisma/client  @prisma/adapter-better-sqlite3
@anthropic-ai/claude-agent-sdk     vendor SDK — Claude, in-process
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
