# Local Atlas TUI — wireframes

Scope: a **fully local** Atlas. No host, no Postgres, no sandboxes, no web. State in a local
SQLite file; sessions run through the Agent SDK in-process against the real cwd.

Structure is carried from day one — **Project → Job → ThreadGroup → Thread → EngineSession →
Message** — but v1 runs one of each. The thing being proven is the **Agent SDK abstraction
across multiple SDKs**, and that seam lives on `EngineSession`.

Transition logic is deliberately absent — it is being solved separately. Groups exist as a
column; nothing advances them.

> Note: `docs/orchestration-shapes.md` lists "local TUI harness" as **Out of scope**. That
> call was about the TUI as a second delivery surface for *orchestration*. This is a local
> harness for proving rendering, streaming, steering, and the engine seam.

## v1 cut line

v1 proves one thing: **the TUI renders, streams, steers, and talks to Claude the way Claude
Code does.** Everything else in this document exists so it will not need redesigning later —
not so it gets built now. Read the rest as a design target, not a task list.

**Build:**

1. **Conversation** — every state below. This is the deliverable; the rest is access.
2. **Composer and overlays** — `/` and `@`, opening upward.
3. **One working account.** Nothing runs without auth, so a single Claude login is a v1
   prerequisite — the Accounts page and rotation are not.
4. **Projects → Jobs** — only enough to reach a conversation and get back into it.
5. **All seven tables**, `Account` included. Cheap now, expensive to retrofit, and
   `EngineSession` is the socket both the second SDK and the second account plug into.
6. **`/context` as a real directory**, three buckets, created per job. The agent reads and
   writes it with ordinary tools — no page and no tool needed to make it work.
7. **The raw tape** — append-only JSONL per session. Nearly free to write, and the only way to
   debug normalisation once a second engine exists.

**Defer:**

- **Context page, Thread list, Step detail, Transcript page.** Real surfaces, none needed to
  prove a turn works. The tape from (6) means `less` covers transcript debugging until the
  page earns its place.
- **Session rotation** on context pressure. Model it; don't fire it.
- **Auto-rotation between accounts.** The `Account` table lands in v1 because retrofitting it
  is expensive; the Accounts page, the second login, and the rotation policy do not.
- **Codex.** The second engine is the *next* proof, not this one — which is why the engine
  seam is structural now and unused until then.

## The shape of the thing

```
   ~/Developer/atlas          project    a folder on disk you work in
   └─ "fix steering"          job        one unit of work + a shared /context folder
      └─ build                group      one phase instance
         └─ builder           thread     one role, one continuous conversation
            ├─ session 1      engine     an SDK session — rotates on context pressure
            └─ session 2      engine     same conversation, new session underneath
```

**Threads are a rotation record, not parallel workspaces.** Opening a job lands directly on
its active thread, never on a picker. The model does not forbid two active threads; nothing
optimises for it. This is why the thread navigator is a **timeline, not a tree**.

### Legs are sessions, not threads

Rotation on context pressure produces a **new `EngineSession` inside the same thread**, not a
new thread. The user is having one conversation with one builder; that the SDK session
underneath was swapped is an implementation detail of context management.

This makes the merged transcript native rather than a rendering trick — messages hang off the
thread, so the scroll is continuous by construction, and the rotation seam is *derived* from
consecutive messages changing `engineSessionId`. Nothing needs to stitch anything.

It also means a thread is genuinely "one role, one purpose", which is what `EThreadRole` was
always trying to say. `builder · leg 2` becomes `builder`, session 2.

> This diverges from `orchestration-shapes.md`, where legs are threads. The local model looks
> better and is probably worth back-porting, but that is the other chat's call.

---

## No permissions

**Atlas allows everything.** There is no permission prompt, no approval card, no permission
mode, no `waiting` run state, and no `shift+tab` cycle. The agent acts.

This removes an entire state from every component below. It also removes what would have been
a useful normalisation checkpoint between the two SDKs — the tool-call surface has to carry
that alone now.

---

## Visual language

Modelled on Claude Code's TUI. Implementation is [Ink](https://github.com/vadimdemedes/ink)
(MIT) — the same foundation Claude Code is publicly known to use.

**Sourcing note:** the "reconstructed Claude Code" repos on GitHub are rebuilt from
Anthropic's March 2026 source-map leak, i.e. leaked proprietary source. Nothing here is taken
from them. The grammar below is observable output; Ink is public and MIT.

| Glyph | Meaning |
|---|---|
| `>` | user input — in the composer and echoed in the transcript |
| `⏺` | an assistant action or message block; coloured by outcome |
| `⎿` | the result of the action above it, indented two |
| `✻` | thinking, and the working spinner |
| `… +N lines` | truncation, expandable |
| `╭─╯` | rounded box — the composer, and overlays above it |

Four rules that matter more than the glyphs:

1. **No timestamps, no speaker rules.** Density comes from removing chrome. A transcript
   should read like a log, not a chat app.
2. **Finished output goes to real terminal scrollback** via Ink's `<Static>`; only the live
   tail re-renders. Native scroll and copy survive, so no alt-screen.
3. **Overlays open upward.** Command and file pickers render *above* the composer, never
   below it. The composer stays put; the list grows away from it. Anything that moves the
   composer costs the eye a jump on every keystroke.
4. **One accent colour**, for the active `⏺` and the selected `❯`. Red only for failure.

---

## Data model

Local-only and designed fresh — the Postgres schema in `backend/prisma/schema.prisma` is for
the cloud harness and does not port (`@db.Uuid` / `dbgenerated` / `where: raw(...)` / `pgbase`
throughout). What transfers is the model shape and the Prisma client API.

**SQLite via Prisma 7 is the system of record.** Verified against 7.9.1 — validates and
`db push` creates the tables.

- `enum` and `Json` **work**; `String[]` scalar lists are **rejected** (the only divergence).
- Enum values need **separate lines**; the compact `{ a b }` form is a parse error, reported
  on the *following* enum.
- Enums render as bare `TEXT`, **no CHECK constraint** — enforcement is Prisma-side.
- `prisma.config.ts` needs **both** `datasource.url` and `adapter`.
- **Migrations, not `db push`** — `prisma migrate dev` generates the SQL. Greenfield means
  `migrate reset` is always available, so no schema change ever needs to preserve data.

```prisma
enum EEngine {
  claude
  codex
}

enum EJobStatus {
  active
  idle
  shipped
}

enum EThreadStatus {
  active
  closed
}

enum ESessionEndReason {
  context_pressure
  thread_closed
  engine_error
  manual
}

enum EAccountStatus {
  active
  limited
  expired
  revoked
}

enum EGroupKind {
  intake
  design
  planning
  build
  master_review
  post_build
  ci
}

enum EThreadRole {
  intake
  research
  spike
  designer
  planner
  plan_review
  builder
  master_review
  post_build
  ci
}

enum EMessageType {
  user
  assistant
  thinking
  tool_call
  tool_result
  error
}

// A subscription login Atlas holds and rotates between.
model Account {
  id               String         @id @default(uuid())
  engine           EEngine
  label            String
  accountEmail     String?
  subscriptionType String?
  status           EAccountStatus @default(active)

  materialEnc      String         // AES-256-GCM; key at ~/.atlas/key (0600)
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

model Project {
  id           String   @id @default(uuid())
  path         String   @unique
  name         String
  lastOpenedAt DateTime @default(now())
  jobs         Job[]
}

model Job {
  id             String        @id @default(uuid())
  projectId      String
  project        Project       @relation(fields: [projectId], references: [id], onDelete: Cascade)
  title          String
  status         EJobStatus    @default(active)
  activeThreadId String?
  groups         ThreadGroup[]
  createdAt      DateTime      @default(now())
  updatedAt      DateTime      @updatedAt
}

model ThreadGroup {
  id      String     @id @default(uuid())
  jobId   String
  job     Job        @relation(fields: [jobId], references: [id], onDelete: Cascade)
  kind    EGroupKind
  title   String?
  ordinal Int
  threads Thread[]

  @@unique([jobId, ordinal])
}

// One role, one continuous conversation. Survives session rotation.
model Thread {
  id              String          @id @default(uuid())
  groupId         String
  group           ThreadGroup     @relation(fields: [groupId], references: [id], onDelete: Cascade)
  role            EThreadRole
  status          EThreadStatus   @default(active)
  activeSessionId String?

  sessions        EngineSession[]
  messages        ThreadMessage[]
  createdAt       DateTime        @default(now())
  closedAt        DateTime?

  @@index([groupId])
}

// One SDK session under a thread. THIS is the multi-SDK seam.
model EngineSession {
  id              String             @id @default(uuid())
  threadId        String
  thread          Thread             @relation(fields: [threadId], references: [id], onDelete: Cascade)
  ordinal         Int                // "leg 2"

  accountId       String             // the account CURRENTLY running it; updated on rotation
  account         Account            @relation(fields: [accountId], references: [id])

  engine          EEngine            // from the thread's role, frozen at creation
  model           String
  engineSessionId String?            // the SDK's own id, for resume

  seededFromId    String?            // the session this one took a handoff from
  handoff         String?            // what was carried across the seam
  endReason       ESessionEndReason?

  messages        ThreadMessage[]
  createdAt       DateTime           @default(now())
  endedAt         DateTime?

  @@unique([threadId, ordinal])
  @@index([accountId])
}

model ThreadMessage {
  id        String        @id @default(uuid())
  threadId  String                    // messages hang off the THREAD — continuous transcript
  thread    Thread        @relation(fields: [threadId], references: [id], onDelete: Cascade)
  sessionId String                    // ...but remember which session produced them
  session   EngineSession @relation(fields: [sessionId], references: [id], onDelete: Cascade)
  ordinal   Int
  type      EMessageType
  payload   Json                      // NORMALISED shape — never raw SDK output
  createdAt DateTime      @default(now())

  @@unique([threadId, ordinal])
  @@index([sessionId])
}
```

```ts
// prisma.config.ts — both fields required
import { defineConfig } from 'prisma/config'
import { PrismaBetterSQLite3 } from '@prisma/adapter-better-sqlite3'

const url = `file:${process.env.HOME}/.atlas/atlas.db`

export default defineConfig({
  schema: 'schema.prisma',
  datasource: { url },
  adapter: async () => new PrismaBetterSQLite3({ url }),
})
```

Four deliberate choices:

- **Messages hang off the thread, tagged with a session.** Ordering is thread-scoped, so the
  transcript is continuous with no stitching. `@@unique([threadId, ordinal])` enforces it.
- **The rotation seam is derived, not stored.** Render a seam wherever consecutive messages
  change `sessionId`. No event row to keep in sync with reality.
- **`activeThreadId` / `activeSessionId` are pointers, not queries.** "Latest active" as a
  query silently breaks the day a second one is active.
- **`payload` is normalised, never raw.** Two SDKs must produce one shape; storing raw output
  would let the abstraction stay unproven.

### The raw tape

`~/.atlas/sessions/<engineSessionId>/raw.jsonl` — append-only, exactly what the SDK emitted.
Nothing reads it normally. It exists because when normalisation is wrong you need the original
bytes, and its shape differs per SDK by definition so it cannot be schema'd. Keyed by session,
not thread, because that is the unit an SDK actually owns.

---

## The shared /context folder

**This is how threads share context.** A job-scoped folder every thread in the job reads and
writes — carried over from legacy, where it lived at `<agentHome>/contexts/<org>/<job>/` and
mounted at `/context` in the sandbox.

Local layout — **three buckets**:

```
~/.atlas/jobs/<jobId>/context/
  specs/        the plan — a multi-file SWE planning set, written by agents
  generated/    prose Atlas captured — answered questions, thread hand-offs
  artifacts/    agent output meant to be looked at — screenshots, HTML bundles
```

### specs/ is a planning set, not a file

`specs/` mimics how a real SWE planning and scoping session actually ends up: not one
`plan.md`, but however many documents the work needs.

```
  specs/
    plan.md            the implementation plan
    prd.md             what is being built and why
    architecture.md    structure, boundaries, patterns
    data-model.md      schema and entity decisions
    research.md        what was explored, and what was rejected
```

**Agents write these.** Legacy `plan-review.service.ts:443` hashed the *entire directory*
(relative paths, for host-stability) to detect plan drift — which is what makes `specs/` the
contract between planning and build rather than a scratch pad. **The set is the unit, not any
one file.** A small job may only ever produce `plan.md`; that is the same shape, smaller.

### generated/ is captured, not authored

`generated/` is **written programmatically by Atlas** — not by a human, and not by an agent
choosing to write a file. Its *content* is prose, because what Atlas captures is model output:
an answered question, or a builder thread's closing message promoted to a file so sibling
threads can pick it up as context.

That makes it the mechanical half of the shared folder. `specs/` is what an agent decided to
write down; `generated/` is what Atlas decided was worth keeping. Legacy kept it out of the
git worktree deliberately ("ADR 0004 relocation") — it is Atlas's record, not the repo's.

Agents can read and write the directory like any other. **Nothing populates it in v1**: the
writer is session-transition orchestration, which is being designed separately. The folder
exists and is reachable from day one so that when the writer lands there is nothing to wire.

`artifacts/` holds renderable output, and nested bundles are normal
(`sidebar-redesign/index.html` + `style.css`).

### Dropped from legacy

- **`evidence/`** — per-thread proof dirs (`evidence/010-backend`, injected as
  `ATLAS_EVIDENCE_DIR`). Not carried.

### How agents reach it

**With ordinary `Read` and `Write`.** In legacy the folder was mounted into the sandbox at
`/context` and agents simply used it. Local Atlas runs in-process against the real filesystem,
so the same holds — no context tool is needed, and none should be built.

For the record, legacy's `atlas_context_read` is **not** an agent tool. It lives in
`host_old/prod-mcp`, an *operator diagnostics* MCP server — read-only SQL over the Atlas DB,
approval-gated writes, secret redaction, an audit log, and path-jailed reads of any job's
context dir, worktree, and session JSONL. Every tool there takes a `jobId` because it exists
to inspect Atlas from outside, not to work inside a job.

---

## Assumptions

- Target terminal **100×30**, must not break at **80×24**. Wireframes drawn at 72 cols.
- Full-screen pages, one surface at a time.
- DB at `~/.atlas/atlas.db`, WAL mode.
- Finished blocks committed to scrollback; only the live tail re-renders.

---

## Page map

```
  atlas ──▶ Projects ──▶ Jobs ──▶ Conversation ──┬──▶ Accounts     (ctrl+a)
                                      ▲          ├──▶ Context      (ctrl+o)
                                      │          ├──▶ Thread list  (ctrl+h)
                                 active thread   ├──▶ Step detail  (⏎ on tool)
                                                 ├──▶ Transcript   (ctrl+r)
                                                 └──▶ Help         (?)
```

Fast path is three keystrokes: project, job, live thread.

---

## Global chrome

### Breadcrumb

Dim, unboxed, one line. Atlas needs location context that Claude Code doesn't, but it should
not become a status bar. Session ordinal appears only past the first.

```
  atlas › fix steering › builder · session 2              claude opus-5
```

Codex-bound review thread — engine legible without being a control:

```
  atlas › fix steering › master review                    codex gpt-5.4
```

At 80 cols the project segment drops, then the job title truncates.

### Composer

```
╭──────────────────────────────────────────────────────────────────────╮
│ > ▌                                                                  │
╰──────────────────────────────────────────────────────────────────────╯
  ? for shortcuts               dennis@…  ctx 12%  5h 34%  wk 61%
```

The line beneath advertises what is legal on the left, and three meters on the right:

| Meter | Is | Amber | Red |
|---|---|---|---|
| `ctx` | context used in this session | 70% | 85% |
| `5h` | the rolling 5-hour subscription window | 70% | 90% |
| `wk` | the 7-day window | 70% | 95% |

Same two windows the web composer shows. Past the red threshold the window earns its reset
time, because at that point "when does this clear" is the only question worth answering:

```
  ? for shortcuts        dennis@…  ctx 12%  5h 91% · 2h14m  wk 61%
```

**Unknown is a real state, not zero.** Usage is harvested from `rate_limit_event` frames on
the turn stream, so a freshly opened TUI that has not run a turn yet genuinely does not know:

```
  ? for shortcuts                          ctx  0%   5h —     wk —
```

Never show a stale number as if it were current — the web makes the same call (`ok:false` →
"unknown"). At 80 cols the shortcuts hint drops before any meter does.

The account chip appears **only when more than one account exists** — with a single login it
is noise, and the meters already describe the only account there is. When every account is
walled it replaces itself with the thing you actually want to know:

```
  all accounts limited · resumes 21:57            ctx 12%  5h 100%  wk 61%
```

---

## Page 1 — Projects

```
  atlas

  ❯ atlas               ~/Developer/atlas          2 jobs    20:31
    pgbase              ~/Developer/pgbase         1 job     Tue
    mls-studio          ~/Developer/mls-studio     —         Jul 28

    + open a folder…

  ↑↓ select · ⏎ open · / filter · ctrl+c quit
```

**Empty state** — first run:

```
  atlas

  No projects yet.
  Atlas works inside a folder — usually a git repo.

  ❯ + open a folder…
```

**Stale row** — path gone. Kept visible rather than silently dropped, so a moved repo is a
decision rather than a mystery:

```
    old-thing           ~/Developer/old-thing      ⚠ path missing
```

---

## Page 2 — Jobs

```
  ‹ atlas

  ❯ ⏺ fix steering             build · builder     claude     20:31
    ⏺ health endpoint          shipped             claude     Tue

    + new job

  ↑↓ select · ⏎ open active thread · ctrl+h threads · esc back
```

`⏺` is accent for active, dim for shipped. Enter goes to `activeThreadId`, never a picker.

**New job** — title only. Engine is not an input; it follows role:

```
╭──────────────────────────────────────────────────────────────────────╮
│ > fix steering▌                                                      │
╰──────────────────────────────────────────────────────────────────────╯
  new job · starts an intake thread on claude          ⏎ create · esc
```

---

## Page 3 — Conversation

### Message grammar

```
> the steer isn't being consumed after a tool result

⏺ Let me look at how the queue drains.

⏺ Read(backend/src/host/turn-dispatcher.service.ts)
  ⎿  Read 210 lines

⏺ Update(backend/src/host/turn-dispatcher.service.ts)
  ⎿  Updated with 6 additions and 2 removals

⏺ Bash(pnpm test steer)
  ⎿  PASS  steer-consumption.spec.ts (4)
     … +18 lines (ctrl+r to expand)

⏺ Fixed — the queue was drained before the tool loop re-entered.
```

**Engine-agnostic by construction** — it renders `ThreadMessage.payload`, so a Codex turn and
a Claude turn are byte-identical apart from the breadcrumb. If they aren't, normalisation is
wrong, which is exactly the bug this build exists to expose. With permissions gone, the
tool-call surface is the *only* remaining checkpoint where the two SDKs must agree.

Failure is red and keeps its result:

```
⏺ Bash(pnpm test steer)
  ⎿  FAIL  steer-consumption.spec.ts > drains after tool result
     exit 1 · 18s · … +42 lines (ctrl+r to expand)
```

### State A — empty (new job, first thread)

```
  atlas › fix steering › intake                           claude opus-5

  ~/Developer/atlas on feat/atlas-v2

  Describe the work, or / for commands.

╭──────────────────────────────────────────────────────────────────────╮
│ > ▌                                                                  │
╰──────────────────────────────────────────────────────────────────────╯
  ? for shortcuts                          ctx  0%   5h —     wk —
```

### State B — streaming text

```
> the steer isn't being consumed after a tool result

⏺ Let me look at how the queue dra▌

✻ Working for 4s (↑ 1.2k tokens · esc to interrupt)

╭──────────────────────────────────────────────────────────────────────╮
│ > ▌                                                                  │
╰──────────────────────────────────────────────────────────────────────╯
  esc interrupt · type to queue a steer      ctx 12%  5h 34%  wk 61%
```

### State C — thinking

```
✻ Thinking…

  The dispatcher drains the queue before re-entering the tool loop,
  so a steer landing mid-tool is consumed but nev▌
```

Collapsed once the turn moves on:

```
✻ Thinking… (18 lines · ctrl+r to expand)
```

### State D — tool running

The running call keeps its `⏺` and gains a spinner in the result gutter, so a long tool never
looks like a hang.

```
⏺ Read(backend/src/host/turn-dispatcher.service.ts)
  ⎿  Read 210 lines

⏺ Bash(pnpm test steer)
  ⎿  ⠙ running… 12s
     RUN  v3.2.4  /Users/dennis/Developer/atlas/backend
      ✓  steer-consumption.spec.ts (4)

✻ Working for 12s (esc to interrupt)
```

### State E — steering (queued input)

Steering is the reason this milestone exists. Typing during a busy turn is **always safe** and
never interrupts. Queued messages render **under the working line**, where the eye already is:

```
⏺ Bash(pnpm test steer)
  ⎿  ⠙ running… 12s

✻ Working for 4m 5s (↑ 8.1k tokens · esc to interrupt)
  ⤷ also check the tool-result path

╭──────────────────────────────────────────────────────────────────────╮
│ > ▌                                                                  │
╰──────────────────────────────────────────────────────────────────────╯
  ctrl+u clear queue · esc interrupt         ctx 12%  5h 34%  wk 61%
```

Several stack in delivery order:

```
✻ Working for 4m 5s (↑ 8.1k tokens · esc to interrupt)
  ⤷ also check the tool-result path
  ⤷ and add a regression test
```

**Consumed at the next tool boundary**, at which point the queued line leaves the working area
and enters the transcript as an ordinary `>` block:

```
⏺ Bash(pnpm test steer)
  ⎿  PASS  steer-consumption.spec.ts (4)

> also check the tool-result path

⏺ Looking at the tool-result path now.

✻ Working for 4m 18s (esc to interrupt)
```

Queue provenance is a working-area concern; history keeps no trace of it.

### State F — interrupted

```
⏺ Bash(pnpm test steer)
  ⎿  Interrupted by user

> stop, only run the steer spec
```

Esc with an empty composer interrupts bare. Esc with text is a **steer-now**: interrupt, then
deliver immediately rather than waiting for a boundary that will never come.

### State G — error

Errors are transcript entries, not toasts — they must survive scrollback.

```
⏺ API Error: 529 overloaded
  ⎿  Retrying 2/5 in 4s…
```

Terminal:

```
⏺ API Error: 401 unauthenticated
  ⎿  Run `claude login` to reauthenticate · r to retry
```

### State H — context pressure and session rotation

The seam is **derived** from `sessionId` changing between adjacent messages — nothing is
stitched, because the messages were always on one thread.

```
  atlas › fix steering › builder                          claude opus-5

⏺ Context at 92% — rotating session
  ⎿  Handoff written · session 1 closed at 124 messages

──────────────────────────  session 2  ──────────────────────────

⏺ Picking up: the queue drain fix is in, tests pend▌
```

You did not navigate anywhere. The breadcrumb gains `· session 2`; the scroll continues.

### State I2 — account rotation on usage limit

Atlas holds several accounts and swaps when one hits its wall. **This is not a session
rotation and no context is lost** — the API is stateless, so the transcript is resent each
turn and only the credential changes. Same session, same scroll, no seam:

```
⏺ Bash(pnpm test steer)
  ⎿  PASS  steer-consumption.spec.ts (4)

  ⤿ switched to work@company · dennis@personal hit its 5-hour limit

⏺ Now let me check the tool-result path▌
```

A dim one-line note in the flow, not a divider. Rotation is bookkeeping the user should be
able to *see* but never have to *think* about — a seam would imply a discontinuity that isn't
there.

Preferred path is **before** a turn, not during one: when the active account crosses ~95% and
another has headroom, swap between turns so no work is lost. The only real cost is the prompt
cache, which is per-account — the first turn after a swap pays uncached input.

**All accounts limited** — nothing to rotate to, so park and be specific about when it clears:

```
⏺ All Claude accounts are at their limit
  ⎿  dennis@personal  resets 2h14m  ·  work@company  resets 41m
     Resuming automatically at 21:57 · r to retry now
```

### State J — engine down

```
⏺ Engine error: claude agent sdk exited (code 1)
  ⎿  Thread preserved · r to restart · ctrl+r for transcript
```

Restart opens a **new session under the same thread** with `endReason = engine_error` on the
old one — the same path rotation uses, so crash recovery is not a special case.

---

## Page 4 — Accounts

`ctrl+a`. Atlas owns auth, so this is where accounts live. Multi-account is what makes the
local harness better than running `claude` directly — it can keep working past one account's
wall.

```
  ‹ atlas                                                      accounts

  claude
  ❯ ⏺ dennis@personal      max 20x     5h  91% · 2h14m   wk  61%
    ○ work@company         max 5x      5h  12%           wk  34%
    ○ side@gmail           pro         5h   —            wk   —     ⚠ expired
  codex
    ○ dennis@openai        plus        5h   4%           wk   9%

    + add an account

  ↑↓ select · ⏎ make active · r refresh usage · x remove · esc back
```

`⏺` accent is the account running now; `○` is available. The `—` on `side@gmail` is honest:
usage is harvested from turns, so an account that has not run recently has **unknown** usage,
not zero. Rotation prefers known headroom over unknown.

**Adding an account** — Claude uses a paste-back OAuth code, matching the web's flow:

```
  ‹ accounts                                              add · claude

  1. Open this URL and approve:

     https://claude.com/cai/oauth/authorize?client_id=9d1c250a…

  2. Paste the code you're given:

╭──────────────────────────────────────────────────────────────────────╮
│ > ▌                                                                  │
╰──────────────────────────────────────────────────────────────────────╯
  o open in browser · ⏎ submit · esc cancel
```

Codex uses a device code instead, so the same page swaps step 2 for a wait:

```
  2. Enter code  BDWX-QRTF  then come back.

  ⠙ waiting for approval… 34s
```

**Empty state** — this is also the first-run blocker, since nothing can run without an
account:

```
  ‹ atlas                                                      accounts

  No accounts yet.

  Atlas signs in on your behalf and rotates between accounts when one
  hits its usage limit. Add at least one to start.

  ❯ + add a Claude account
    + add a Codex account
```

---

## Page 5 — Context

`ctrl+o`. The job's shared folder. The one page that is about the job rather than the
conversation, and the mechanism by which threads share anything at all.

```
  ‹ fix steering                                                context

  specs/                                              5 files · planner
    plan.md                         4.2 KB   planner        20:52
    prd.md                          2.1 KB   planner        20:50
    architecture.md                 3.4 KB   planner        20:55
    data-model.md                   1.8 KB   planner        20:57
    research.md                     6.7 KB   research       20:41
  generated/                                        empty in v1
  artifacts/
    sidebar-redesign/               2 files  designer       Tue
    shot.png                        142 KB   builder        21:32

  ↑↓ select · ⏎ view · a all specs · o open externally · @ mention · esc
```

The author column is the **thread role that wrote it**, which is what makes this a shared
folder rather than a pile of files — you can see which conversation produced what.

`a` opens the whole spec set as one continuous document. Since plan drift is measured over
the directory, the set is the reviewable unit, and reading it a file at a time hides
contradictions *between* files — which is exactly where planning goes wrong.

**Viewing a text file** — full-screen, rendered if markdown:

```
  ‹ context                                            specs/plan.md

  # Implementation plan

  ## Backend
  1. Drain the steer queue *after* the tool loop re-enters, not before.
  2. Add a regression test covering the tool-result boundary.

  ↑↓ scroll · n/p next/prev spec · @ mention · o open externally · esc
```

**Binary or renderable** — the terminal cannot show it, so say so plainly and hand it off
rather than rendering something useless:

```
  ‹ context                                       artifacts/shot.png

  PNG · 1440×900 · 142 KB · written by builder · 21:32

  Terminal can't render this.
  ❯ o  open in default app
    y  copy path
```

**Empty state** — the honest v1 picture, and a place to say what the folder is for:

```
  ‹ fix steering                                                context

  Nothing here yet.

  Threads share this folder. Planning agents write the spec set into
  specs/ — plan.md, prd.md, architecture.md, whatever the work needs.
  Anything worth looking at lands in artifacts/.

  ~/.atlas/jobs/8f3a…/context
```

---

## Page 6 — Thread list

`ctrl+h`. One row per thread — per *role*, now that legs are sessions. A timeline, because
threads are sequential history and only the last is live.

```
  ‹ fix steering                                                threads

  intake
    ○ intake                 claude    38 msgs   1 session   closed
  planning
    ○ planner                claude    52 msgs   1 session   closed
    ○ plan review            codex     19 msgs   1 session   closed
  build
  ❯ ⏺ builder                claude   136 msgs   2 sessions  ACTIVE

  ↑↓ select · ⏎ open · s sessions · esc back
```

Groups are headers, not nodes. The engine column is per-thread (via its sessions), which is
what makes a mixed-engine job legible and is the clearest evidence the abstraction holds.

`s` expands the session strip — the rotation history that used to be separate thread rows:

```
  ❯ ⏺ builder                claude   136 msgs   2 sessions  ACTIVE
       session 1   claude opus-5   124 msgs   context_pressure  20:41
       session 2   claude opus-5    12 msgs   active            20:41
```

**v1 degenerate state:**

```
  intake
  ❯ ⏺ intake                 claude    12 msgs   1 session   ACTIVE
```

---

## Page 7 — Step detail

Enter on any tool row.

```
  ‹ conversation                                     Update · step 4/7

  backend/src/host/turn-dispatcher.service.ts                   +6 -2

   118    const steers = await this.queue.drain(threadId)
   119 -  if (steers.length) return this.deliver(steers)
   119 +  if (steers.length) {
   120 +    await this.deliver(steers)
   121 +    continue
   122 +  }

  ↑↓ scroll · n/p next/prev step · y copy path · esc back
```

Bash variant swaps the diff body for full stdout/stderr under an `exit 1 · 18s` header.

---

## Page 8 — Transcript

`ctrl+r`. The raw searchable record. Needed early, because debugging streaming means reading
exactly what arrived.

```
  ‹ conversation                                   transcript · /steer

  20:31  user    the steer isn't being consumed after a tool result
  20:31  text    Let me look at how the queue drains.
  20:31  tool    Read     host/turn-dispatcher.service.ts
  20:35  error   529 overloaded                          → retried
  20:41  seam    session 1 → 2                           ctx 92%
  20:41  text    Picking up: the queue drain fix is in…

  / search · ⏎ jump · t toggle raw tape · s filter by session · esc
```

Timestamps appear **here and nowhere else** — this is the debugging view, where "when" is the
point. `t` swaps the normalised view for the raw SDK tape, making a normalisation bug
diagnosable in place. `s` scopes to one session, which is how you isolate a suspect leg.

---

## Overlays

**Overlays open upward, above the composer.** The composer never moves.

### Command palette (`/`)

```
  ❯ /thread    open a sibling thread with a given role
    /rotate    close this session and start the next
╭──────────────────────────────────────────────────────────────────────╮
│ > /th▌                                                               │
╰──────────────────────────────────────────────────────────────────────╯
```

Milestone set, deliberately tiny: `/thread`, `/rotate`, `/context`, `/doctor`, `/compact`,
`/help`, `/quit`. No `/engine` — binding is by role. No permission commands — there are no
permissions.

### `/doctor`

Atlas **extends** Claude and Codex rather than replacing them, so "is my setup current" is a
question it owes an answer to. One page, on demand — rather than a nag that gets ignored.

```
  ‹ conversation                                                 doctor

  engines
    ⏺ claude    sdk 0.3.220                              up to date
    ⏺ codex     codex-cli 0.142.5  ~/.local/bin/codex    up to date
  atlas
    ⏺ atlas     0.1.0                                    up to date
    ⏺ database  ~/.atlas/atlas.db  7 tables              migrated
  accounts
    ⏺ claude    2 accounts                               1 limited
    ○ codex     none                                     add one to use codex

  r re-check · esc back
```

Degraded, which is the state that has to read clearly:

```
  engines
    ⚠ claude    sdk 0.3.204                    0.3.220 available
      ⎿  npm i -g @workspace/tui@latest
    ✗ codex     not found on PATH
      ⎿  codex accounts are unusable until it's installed
```

Never blocks a turn, never checks the network more than once a day, and fails silent offline.

### Thread role picker (`/thread`)

The only way to reach a Codex thread in v1 (see the tension flagged below).

```
  ❯ master_review    codex gpt-5.4    review the work so far
    plan_review      codex gpt-5.4    review the plan
    research         claude opus-5    explore a question
    builder          claude opus-5    build against the specs
╭──────────────────────────────────────────────────────────────────────╮
│ > /thread ▌                                                          │
╰──────────────────────────────────────────────────────────────────────╯
```

Selecting one closes the current thread and opens the new role as the job's active thread.

### File mention (`@`)

Searches the worktree **and** the job's `/context`, because a spec is as mentionable as a
source file — and mentioning a spec is how a builder is pointed at the plan.

```
  ❯ context/specs/plan.md                             spec · planner
    backend/src/host/turn-dispatcher.service.ts       worktree
    backend/src/host/turn-dispatcher.spec.ts          worktree
╭──────────────────────────────────────────────────────────────────────╮
│ > @turn-disp▌                                                        │
╰──────────────────────────────────────────────────────────────────────╯
```

---

## Component catalog

| Component | Where | States |
|---|---|---|
| Breadcrumb | all | normal · with session ordinal · read-only · narrow |
| Composer | conversation, pickers | empty · typing · multiline (≤6) · absent (read-only) |
| Hint line | all | shortcuts · queue actions · narrow (shortcuts dropped) |
| Usage meters | hint line | unknown (`—`) · normal · amber · red (+ reset time) — one each for `ctx`, `5h`, `wk` |
| Account chip | hint line | absent (one account) · label · all-limited |
| Account row | accounts | active · available · limited (+ reset) · expired · unknown usage |
| Login flow | accounts | paste-code (Claude) · device-code (Codex, waiting) · failed |
| Overlay list | palette, `/thread`, `@` | filtering · no matches · selecting |
| Project row | projects | normal · has jobs · no jobs · path missing |
| Job row | jobs | active · idle · shipped |
| Thread row | thread list | active · closed; session strip expanded |
| `>` user block | conversation | plain · from queue · with mentions |
| `⏺` assistant block | conversation | streaming (caret) · complete · interrupted |
| `⏺` tool block | conversation | running (spinner in gutter) · ok · failed · interrupted |
| `⎿` result gutter | conversation | summary · streaming · truncated (`… +N`) · error |
| `✻` thinking | conversation | streaming · collapsed · expanded |
| Working line | conversation | absent (idle) · elapsed + tokens + esc · with queued items |
| Session seam | conversation | context_pressure · engine_error · manual |
| Account-swap note | conversation | dim inline `⤿` line — no seam, no discontinuity |
| Context row | context | bucket header · spec file · artifact · nested bundle · binary |
| File viewer | context | markdown · plain text · unrenderable (hand off) · whole spec set |
| Empty state | projects, jobs, threads, context, conversation | first-run · no-jobs · nothing-shared |

---

## Keymap

| Key | Idle | Busy |
|---|---|---|
| `⏎` | send | newline |
| `esc` | clear composer | interrupt (steer-now if composer non-empty) |
| `ctrl+u` | clear composer | clear queue |
| `ctrl+a` | accounts | accounts |
| `ctrl+o` | context | context |
| `ctrl+h` | thread list | thread list |
| `ctrl+r` | transcript / expand | transcript / expand |
| `/` `@` | open overlay (upward) | open overlay (upward) |
| `ctrl+c` | quit (twice) | interrupt, then quit |

No `shift+tab` — permission modes do not exist.

---

## What this proves (and what it deliberately doesn't)

Exercised: **the engine abstraction** — two SDKs behind one normalised message model, one
render grammar, one resume path; session lifecycle and rotation; partial-message streaming
into a re-rendering tail; tool-call lifecycle; mid-turn steering with queue-at-boundary and
interrupt semantics; error/retry; and the shared `/context` folder as the cross-thread
context mechanism.

Structure is **modelled but not exercised**: one project, one job, one group. Groups have no
transitions — solved separately.

Not present: sandboxes, parallel threads, plan approval, CI, Postgres, web, permissions,
engine switching.

## Open

- **Reaching Codex in v1.** Role-bound engines mean an intake thread never touches Codex, so
  the abstraction goes untested. `/thread master_review` is the cheapest opener — right one?
- **Handoff payload.** A new session needs seeding. A summary, or a replay of the normalised
  transcript into the new SDK? The replay doubles as a normalisation proof and is probably
  worth the cost *here* specifically. `EngineSession.handoff` holds whatever wins.
- **What prompts the spec set.** Agents write `specs/`, but in v1 nothing *asks* them to —
  there is no planning phase to enter. Does the intake thread write specs when it decides to,
  or does a `/plan` command exist to ask for one?
- **Context pressure signal.** What actually triggers rotation, and is it forced or offered.
- **Tool output cap** — how many lines before `… +N`; worth measuring rather than guessing.
- **Resize.** `<Static>` output is committed and will not reflow. Accept ragged history, or
  re-render from the model?

**Resolved:** scrollback ownership — Ink's `<Static>` commits finished blocks to the real
terminal buffer while the live region re-renders below, so native scroll and copy survive and
alt-screen is off the table.
