# ADR 0008 — First-class thread groups: `jobs → thread_groups → threads → messages`

- **Status:** Accepted — implemented (5 of the build's 6 threads landed; this ADR documents the data model
  and orchestration it delivers).
- **Date:** 2026-07-14
- **Relates to:** ADR 0004 (thread termination contract — the terminal record now lives on the `threads` row,
  not a `steps` row; still the authority for done/blocked/failed) and ADR 0001 (Redis-Streams turn transport —
  `active_turns.lane` continues as `thread:<id>`; phase/anchor identity now repoints to `thread_id` instead of
  `step_id`). Canonical narrative: `backend/src/app/ARCHITECTURE.md`.

## Context

Before this refactor, a job's build sub-structure was `jobs → threads (build lanes) → steps (leaves)`, plus
two separate satellite tables — `build_legs` and `codex_reviews` — and a flat `messages` table hanging off
`job_id` only (a message's thread was recovered indirectly via `meta.phaseId → steps → thread`). The §N
"thread group" grouping an operator sees in the UI (Foundation, MCP Writer + Audit, …) was not a real row
anywhere — it was derived at read time from a builder thread's session-rotation legs. This left several
things stuck together that needed to come apart:

- **A "leg" was really a session rotation of one thread**, tracked via `steps.leg_ordinal` /
  `rotating_session_id` / `pending_leg_seed` — not a first-class row, so a rotated leg had no independent
  identity, cost attribution, or transcript.
- **The build grouping had no table** — adding a pipeline thread group (post_build, ci) meant inventing more
  ad-hoc thread `kind`s and inline branching, not appending a row to a sequence.
- **`messages` were job-scoped, not thread-scoped** — exact per-thread cost/chat attribution and
  "operator-chats-a-builder" both required walking back through `meta.phaseId`.
- **Subagents (Task-tool agents) had no table** — their identity was an ad-hoc `meta.parentToolUseId ↔
  meta.id` pointer pair on `messages`, with no queryable cost/token/lifecycle record.
- **`steps` was a 1:1 satellite of threads** — verified: the only live driver path creates exactly one
  anchor step per thread ("the whole thread is one orchestrator turn"), so the table added a join for no
  real multiplicity.
- **`codex_reviews` duplicated what a `plan_review` thread already almost was** — a session, a spec hash, a
  resume count, findings — just stored on its own table instead of the thread it reviewed.
- **The driver pushed straight back into the one shared Main/planning brain on every halt/done/provisioning
  failure** (`notifyThreadHalted`, `notifyThreadDone`, `wakeForProvisioningFailure` on `BrainGateway`), which
  coupled every failure mode to one continuously-growing context and made "the brain auto-fixes it" the
  only recovery path.

Each of these was a cross-cutting fragmentation: adding a pipeline thread group, fixing per-thread cost
attribution, or normalizing subagents all meant touching the same scattered set of tables and ad-hoc joins.
This ADR records the shape that replaces it.

## Decision

### 1. Legs become first-class builder threads (sequential rotation within a thread group)

A "leg" is not a distinct concept — a leg IS a builder thread. As the operator put it: *"Leg is just a name,
so they're not running in parallel either. A builder thread is a leg. They should be the same thing... when
we spin up a thread group... it's going to spin up a builder thread, which is technically leg one. If that
builder thread hits a context pressure window, then we just rotate it to a second builder thread leg. It's
just a builder thread rotation. They're supposed to be first class."* A thread group owns an ordered set of
`builder` thread rows that run SEQUENTIALLY, never in parallel: builder #1 starts the thread group; on
crossing the context-pressure window it authors a handoff and rotation inserts builder #2 (a plain new
`threads` row, same `thread_group_id`, gap-numbered `ordinal`, `parent_thread_id` chaining), which resumes
the THREAD GROUP's shared task list, not a per-leg one. The thread group's review agents + review_fix run
ONCE at the end over the thread group's cumulative diff — they belong to the thread group, not to one
builder leg. Consequence: the `build_legs` table and `steps.leg_ordinal` / `rotating_session_id` /
`pending_leg_seed` rotation state are retired; rotation is "insert the next builder-thread row under this
thread group, carry the handoff/task list forward."

### 2. Thread group becomes a dedicated first-class table; the pipeline is append-only

The §N build grouping becomes `thread_groups`: `id, job_id, org_id, ordinal (gap-numbered), kind, title
(nullable), type (nullable), status, condition, decision_record_id (nullable), config (jsonb)`. A job's
pipeline is the ordinal-ordered sequence of its thread groups. Generalizing past the original build-only
sketch, EVERY thread belongs to exactly one thread group (`threads.thread_group_id` NOT NULL) — there is no
job-level ungrouped thread, so even a pure-chat job that never builds gets exactly one `planning` thread
group from the start. `kind` ∈ `planning | plan_review | build | direct_build | master_review | post_build |
ci`. `title` is nullable, populated only for `build`/`direct_build` (the slice name) and `planning`
(disambiguating re-plan rounds, e.g. "Re-plan #2"); other kinds derive their label from `kind`. The pipeline
is APPEND-ONLY across re-plan rounds: a large post-build amendment appends a fresh `planning(2) →
plan_review(2) → …` run after the prior thread groups, which stay as visible history rather than being
deleted or renumbered. Plan-revision scoping (`decision_record_id`) moves from the thread onto the thread
group, since it is now a thread-group-level concern.

### 3. Messages re-home onto `thread_id`, backfilled in-file

`messages` becomes thread-scoped: `messages.thread_id` (NOT NULL FK → `threads`) plus `messages.subagent_id`
(nullable FK, rider 4). A job's conversation log is the union of its threads' messages; `job_id` stays
denormalized for job-wide queries. The backfill runs INSIDE the single migration, not a separate script: add
nullable `thread_id` → derive it from `meta.phaseId → steps.id → steps.thread_id` where resolvable →
default any orphan (the brain/planning conversation, or anything with no resolvable step) to the job's
`planning` thread → enforce NOT NULL + FK + a `(thread_id, created_at)` index. This is the cornerstone that
makes operator-chats-a-builder, exact per-thread cost attribution, and subagent-transcripts-as-thread-messages
fall out for free, rather than each needing its own bespoke join.

### 4. Subagents get a dedicated table, not a fold into `threads`

Subagents (Task-tool-spawned agents like `explore`/`implement`/`review`) are NOT threads — no stimulus
intake, SDK-owned lifecycle, ephemeral, not steerable or resumable. A dedicated `subagents` table replaces
the ad-hoc `meta.parentToolUseId ↔ meta.id` pointer pair: `id, thread_id (parent thread it ran inside),
parent_message_id (the Task tool_use block that launched it), tool_use_id, agent_type, model, status,
session_ref, input/output/cache tokens, cost_usd, started_at, ended_at`. Transcript fidelity keeps the
streamed subagent blocks in `messages` (now keyed by `subagent_id`), plus `session_ref` for full raw-JSONL
depth. Rendering becomes uniform: "messages for a node," where a node is either a thread (`subagent_id IS
NULL`) or a subagent (`subagent_id` set) — one rendering path instead of two.

### 5. `steps` is retired; `session_id`/`commit_sha`/phase identity relocate to `threads`

Verified 1:1 with threads before removal — the only live driver path creates exactly one anchor step per
thread. Its three load-bearing residuals relocate rather than disappear: `session_id` (the resume source of
truth) and `commit_sha` (the commit/diff-range marker) move onto the `threads` row; the anchor/phase identity
(`message.meta.phaseId`, `turn_stats.step_id`) repoints to `thread_id`. Historical rows are backfilled in the
same migration. `codex_reviews` is retired the same way, folding into the `plan_review` thread instead of its
own table: the Codex session → `thread.session_id`; `spec_hash`/`resume_count`/`findings` → `thread.config`.

### 6. Shared task list becomes a dedicated `tasks` table, thread-group-owned

The shared checklist becomes `tasks`, keyed by `thread_group_id`: `id, thread_group_id, org_id, ordinal,
title, brief, active_form, status, blocked_by (jsonb id array)`. This replaces BOTH of the old task blobs —
`threads.tasks` (the build-lane checklist) and `jobs.main_tasks` (the brain checklist). Because the list is
owned by the thread group rather than any one builder thread, rotation (rider 1) is race-free: any builder
thread in the thread group reads/writes `tasks WHERE thread_group_id = X`, and the next leg sees the full
list and keeps crediting it — no jsonb read-modify-write races. The LLM tool surface
(`TaskCreate`/`TaskUpdate`) is unchanged; handlers just write rows keyed to the active thread group now.

### 7. Kind-specific behavior/metadata: registry + config jsonb, never per-kind tables

Cross-cutting principle, not specific to one table: kind-specific BEHAVIOR lives in a declarative registry in
code (`thread-group-kind/registry.ts`'s `THREAD_GROUP_KIND_SPECS`, `thread-kind/registry.ts`'s
`THREAD_KIND_SPECS`), both boot-validated so a misconfigured kind fails at startup, not mid-build — adding a
kind is one registry entry, not a new table+entity+repository+joins. Kind-specific PARAMS live in a `config
jsonb` column (`thread_groups.config`, `threads.config`); a field is promoted to a real typed column only
when it must be queried/indexed/FK'd (e.g. `thread_groups.type` for review-agent selection,
`threads.session_id`/`commit_sha` for resume). This is the direct counter-lesson to the fragmentation in the
Context above — it is the reason this refactor doesn't just recreate a `build_legs`/`codex_reviews`-shaped
problem one level up.

### 8. `direct_build` — a no-review fast path thread-group kind

`threadGroup.kind = 'direct_build'` holds a SINGLE builder thread and nothing else — no `review_agent`, no
`review_fix`, no `master_review` thread group — but still flows through `post_build` + `ci` like every other
pipeline. In the operator's words: *"for `direct build`, lets do a `threadGroup.kind = direct_build` and this
just has a single builder with no review agents, and no master review. That way we still get post_build, and
CI threads to do their work... what a direct build is, essentially, is a `no review` pipeline."* This
replaces the old brain-inline direct-build code path (no builder threads at all, driver never engaged) with
one more `THREAD_GROUP_KIND_SPECS` entry — the fast path is now fully uniform with the thread-group/thread
machinery instead of a special case.

### 9. Headless driver — rip the driver→brain wake surface

The build driver becomes HEADLESS: a thread that halts or fails no longer wakes the planning brain to
auto-fix. `BrainGatewayHandler`'s three push-notify methods — `notifyThreadHalted`, `notifyThreadDone`,
`wakeForProvisioningFailure` — are removed, along with the `retry_thread` auto-fix loop that existed only to
serve them. A halted/failed thread simply records its halt (`threads.halt_outcome`) and surfaces as `halted`
in the UI for the operator to inspect, steer, or retry directly. This removes the "halt bounces to Main"
coupling that made the system hard to change, and is the prerequisite for per-thread headless operation.

### 10. Uniform operator chat, per-role enable toggle — the replacement for the ripped-out auto-fix

Because messages are now thread-scoped (rider 3), any thread CAN carry an operator message stream. The
operator's framing: *"Everything thread is technically chattable, they should all SUPPORT it, so it's just as
simple as a toggle to enable/guard operator chats."* Every thread supports operator input uniformly (the
`stimuli.lane`/`DeliveryPump`/`active_turns.steerable` steer plumbing already existed); whether a given ROLE
accepts it is one boolean, `operatorInput`, in the thread-kind registry. Defaults: ON for `builder` and
`planning`, OFF (read-only) for `review_agent`/`review_fix`/`master_review`/`plan_review`/`post_build`/`ci` —
but any role is a one-line flip. A live steerable thread gets the message mid-turn; a halted one gets it as
guidance that folds into the thread's orientation and triggers a re-drive. This is the direct, deliberate
replacement for decision 9's removed auto-fix loop: recovery is operator-initiated, not autonomous.

### 11. Resume model: `commit_sha`/`start_sha` are the review-diff boundary, not a resume guard

Two complementary durability layers stay separate. `threads.session_id`/`status`/`condition` plus (for
build/direct_build thread groups) `start_sha`/`commit_sha` are DURABLE state on the thread row; `active_turns`
remains the volatile, high-churn LIVE in-flight-turn registry (heartbeats, `events_last_id`, `container_id`,
`ctx`, `steerable`), kept separate because it is not 1:1 with a thread (a thread has many turns over its
life — legs, retries — with at most one running at a time) and merging would cause write amplification on
the core durable table. On restart, the system CONTINUES the running thread: re-attach the live engine via
`active_turns` if its container is alive, else resume the same `session_id`; completion is the durable
`complete_thread` terminal record (ADR 0004). `commit_sha` is therefore NOT the primary resume idempotency
guard — always-continue + the terminal record already cover that. Its real, retained role is defining each
build/direct_build thread group's REVIEW DIFF: reviewers receive the cumulative range `start_sha..commit_sha`.
Non-build thread groups need no commit range.

### 12. Full split now, orchestration-only — prompting deferred to a follow-up

The split of "Main" into dedicated thread-group threads lands in full THIS job, but scoped to pipeline
ORCHESTRATION, not prompt engineering. This job builds the complete set of spawn seams — `planning` at job
start (Main re-homed into a `planning` thread group's thread), `plan_review` during planning,
`build`/`direct_build` at dispatch, `master_review` after all build thread groups, `post_build` once all
build thread groups + `master_review` complete, `ci` post-ship. `post_build` and `ci` become live thread
groups that take over ship/amend and CI from Main; `openPrAtShip` moves onto the `post_build` thread group's
own fresh session. Per the operator's explicit scope limit: *"It shouldn't be that complicating, don't worry
about prompting... We'll have them all use the same prompting. It's the pipeline orchestration that we need
to get solid now... Splitting main should be trivial after the foundation, but the long part would be the
correct context engineering, system prompting, JIT prompting, etc. For that, we will defer into a follow
up."* So every new thread-group thread reuses the SAME system prompting as today's brain, seeded with a
minimal initial message (`post_build` gets the same "ship now" message Main used to receive; `ci` reuses the
existing CI-handling prompt surface). Dedicated per-thread-group context engineering — tuned system prompts,
lean cross-thread-group handoff packets, JIT prompt rules — is explicitly deferred to a follow-up job.

### 13. Live-e2e validation approach (test-scoped, not a structural decision)

To prove the pipeline transitions cheaply during this build, Claude-engine thread groups (builders,
`review_agent`, `review_fix`, the verification judge, `post_build`, `ci`) were pinned to Haiku for live e2e
turns; Codex thread groups (`plan_review`, `master_review`) were kept to a single minimal turn or stubbed
with the existing test-engine harness, since Codex rejects an explicit `model` override and proving a
thread-group transition fires doesn't require real review quality. This is a validation-harness note, not a
schema or orchestration decision, and does not affect the production model above.

## Consequences

**Positive:**
- Adding a pipeline thread group or thread role is a one-line registry entry (rider 7), not a new
  table+entity+repository+joins.
- Exact per-thread cost and chat attribution falls out of thread-scoped messages (rider 3) — no more
  `meta.phaseId` archaeology.
- A halted thread no longer silently bounces into an overloaded, ever-growing Main context (riders 9–10) —
  it surfaces plainly and the operator drives recovery on the thread that actually needs it.
- Rotation is race-free: the thread-group-owned task list (rider 6) means a rotated leg picks up exactly
  where the last one left off, with no jsonb read-modify-write window.
- Subagents get real cost/token/lifecycle records (rider 4) instead of an ad-hoc message-meta pointer pair.

**Negative / costs:**
- One big, one-way migration (`backend/migrations/1784083987667-FirstClassThreads.ts`): creates
  `thread_groups`/`tasks`/`subagents`, backfills thread groups/roles/session ids/task rows/message thread
  ids/subagent rows, then drops `steps`, `build_legs`, `codex_reviews`, and three columns. `down()` is
  best-effort (dropped tables come back empty) — this is a deliberate one-way structural door. A later,
  additive migration (`1784091234567-RenameStagesToThreadGroups.ts`) renames the `stages` table and
  `stage_id`/`stage-kind` naming to `thread_groups`/`thread_group_id`/`thread-group-kind` to match this ADR's
  vocabulary.
- The headless driver (rider 9) means the operator must actively steer a halt now — there is no more
  automatic retry loop quietly fixing things in the background; a halt that used to silently resolve itself
  now waits for a human (or the durable owed-wake sweep, for the cases that still legitimately need it).
- Per-thread-group context/prompt engineering is deferred (rider 12): `post_build`/`ci` currently reuse
  Main's prompting verbatim, which is a known, temporary rough edge until the follow-up job dials in
  dedicated per-thread-group prompting.

## Alternatives considered

- **Keep legs as a separate `build_legs` projection table.** Rejected — a leg has no property a thread
  doesn't already have (session, status, ordinal, commit anchor); a separate table would only exist to
  answer "is this row a leg," which the thread-group/role model already answers for free.
- **Fold subagents into `threads`.** Rejected — subagents are SDK-owned, ephemeral, not steerable, not
  resumable, and have no stimulus intake; folding them in would pollute the core orchestration table and the
  thread-kind registry with degenerate, non-executable rows — the opposite of the "easy to add a kind" goal
  this refactor is for.
- **Per-kind satellite tables for thread-group/thread metadata** (a `build_thread_group_meta`, a
  `planning_thread_meta`, …). Rejected — this recreates the exact fragmentation (`build_legs`,
  `codex_reviews`, one-table-per-kind) that this refactor exists to remove. The registry + `config jsonb`
  pattern (rider 7) is the deliberate alternative.

This ADR is the standalone reference for the thread-group/thread model: ADR 0004's terminal record now lives
on the `threads` row (not `steps`), and ADR 0001's phase/anchor identity now keys on `thread_id` (not
`step_id`) — both ADRs carry a short pointer here, but the model itself is fully described above.
