# ADR 0009 — Threads Architecture Redesign: host scheduler + per-thread sessions

- **Status:** Accepted — implemented (backend engine + web console + migration land as one atomic PR;
  agent-control validation is removed here and re-added, revised, in a follow-up job).
- **Date:** 2026-07-17
- **Relates to:** supersedes [**ADR 0008 (first-class thread groups)**](./0008-first-class-thread-groups.md)
  IN PART — the containment hierarchy
  (`jobs → thread_groups → threads → messages`, `tasks`, `subagents`) is KEPT; the orchestration model and
  the data-model vocabulary it described are replaced (see "What this changes in ADR 0008" below). Locks the
  14 interview decisions in the job-context decision record (`/context/generated/decision-record.md`,
  referenced below as **d1–d14**). Canonical narrative: `backend/src/app/ARCHITECTURE.md`.

## Context

ADR 0008 made thread groups + threads first-class, but a lot of orchestration tech debt rode in with it, all
hanging off one idea: a persistent **"brain"/Main** session per job (`AgentSessionManager` anchored on
`job_sandboxes.session_id`) that scoped, planned, ran **direct build inline**, seeded post-build/CI, and was
the hub every other thread relayed back into. That single always-growing session, plus the machinery built to
keep it coherent, was the source of most of the fragility:

- **A context window that blows up.** One long-lived session carried the whole job — grilling, decisions,
  plan, every relayed halt/event — until it compaction-continued and leaked "the previous session was
  compacted" onto fresh post-build/ship turns.
- **Cross-thread relays + pipeline-awareness fan-out.** Every build halt/event (`relayFailure`,
  `relaySessionLimitPaused`, `relayCodexReviewOutage`, `relayPaused`, `relayRetrying`) funneled back into the
  one planning brain, and a `pipeline_awareness` store fanned milestones across threads — coupling every
  failure mode to that one context.
- **Three auto-resume sweeps** — the 30-min reap's `driver.resume()` backstop, a `SessionResumeSweep`, and a
  `JobUnblockSweep` — timer-poked dormant work awake, spamming turns and masking real state.
- **A halt/gating overlay on the schema** — `jobs.activity`, `jobs.halted`, a phase-preserving `jobs.halt`
  jsonb, and `threads.condition` — where a single thread halting could halt the whole job.
- **Agent-control validation** — a live-verification judge gating `finalize_build`, a `report_verification`
  requirement, `complete_thread` grading, halt-on-unverified, forced-completion — white-gloving the agents
  instead of trusting them.
- **Direct build as a special inline code path** in the brain (no real threads), separate from the
  thread-group machinery.
- **Two separate planning + plan_review thread groups**, and a `direct_build` kind separate from `build`.

The re-centering idea (d1, one-way door): **Atlas is the automated version of running several Claude Code
sessions on one work tree.** One session plans (the human is involved here); the rest are automated with
context engineering. The **host is a pure pipeline scheduler + JIT context-seeder** — it creates/opens/seeds
threads and advances the pipeline; the **coding sessions are the show.** No persistent brain, no white-gloving.

## Decision

### 1. Host is a scheduler + seeder; every thread is an isolated fresh session (d1)

Dissolve the persistent brain. The host (`driver/thread-driver.service.ts` + the shared per-thread runner
`engine/thread-session-runner.service.ts`) becomes a pure pipeline scheduler + JIT context-seeder: it
appends/opens thread groups & threads, seeds each thread's FRESH session with purpose-built JIT context,
advances `jobs.focused_thread_id`, derives `jobs.status`, delivers operator messages + subscribed host events,
and runs the two product gates. EVERY thread — planning included — runs as its own isolated, freshly-seeded
Claude Code session on the job's shared worktree; there is no persistent Main/brain session and no
compaction-continuation between threads. Planning is simply the first thread. Cross-thread relays and
pipeline-awareness fan-out are deleted — threads are isolated and never relay another thread's halts or events.
(Implementation note: the `brain/` module + `AgentSessionManager` class survive under the legacy name as the
per-thread chat-session runner for the conversational roles — `planner`/`post_build`/`ship` — not a job-wide
orchestrator.)

### 2. Canonical vocabulary: Section, Leg, thread = session (d2)

Containment is unchanged (Job ⊃ Thread groups ⊃ Threads). A builder-kind thread group is a **Section**
(displayed "Section 1/2/3" with the § glyph); a builder thread within a Section is a **Leg** (Leg 1/2/3);
"Thread" = one coding session. Group kinds: `planning · section · master_review · post_build · ship`. Thread
roles: `planner · codex_review · builder · review_agent · review_fix · master_review · post_build · ship`. The
raw gap-numbered `ordinal` stays the INTERNAL append-only sort key and is never displayed — the read model
derives a per-kind, 1-based display index (killing the old "Thread 10/20/30" leak).

### 3. One atomic PR, no feature toggles; validation removed now, re-added in a follow-up (d3)

Deliver as ONE atomic job/PR spanning backend engine + web console + migration, so `main` is never broken
between merges. No feature toggles — what lands is complete and running, and the web app compiles + runs
against the new model in the same PR. Agent-control validation is fully GUTTED here (nothing toggled off, see
rider 5); a separate follow-up job re-adds a revised, better validation system.

### 4. `jobs.focused_thread_id` — server-authoritative routing pointer (d4)

Add `jobs.focused_thread_id` (uuid FK → `threads`, ON DELETE SET NULL). Named "focused", deliberately NOT
"active", to keep ROUTING separate from session LIVENESS (whether a thread currently has a running turn —
which is a runtime signal, never persisted). It is the pointer the console opens to; the URL becomes
`/workspace/:jobId/:threadId`. The host advances it as the pipeline moves (create → planner; approve →
Section 1 Leg 1; each newly-active thread → that thread; `ready` → post_build; `ship_it` → ship); an operator
click overrides it (the console focus-setter).

### 5. Gut all agent-control gating; retain the two product gates (d5)

Remove ALL agent-control gating, clean slate: the direct-build `finalize_build` live-verification judge (the
`LiveVerificationModule`, `live-verification-judge.ts`, `live-verification-support.ts`, the
`LIVE_VERIFICATION_JUDGE` token), the `report_verification` tool + `directBuildVerified` requirement, any
`complete_thread` validation / halt-on-unverified / incomplete-gating, and any forced-completion criteria.
`complete_thread` stays as the ungated completion signal (sets `thread.status='done'` + `terminal_record`); it
never judges. PRODUCT gates are RETAINED: **plan approval** and the **ship gate**. A follow-up job reworks
validation from scratch — leave NO toggles behind.

### 6. Direct build runs a real builder Section with reviews off (d6)

Direct build no longer runs inline in the planning session. Direct-ness is promoted from the decision record
onto the job as `jobs.build_path` (`plan | direct`). On approval a `direct` job dispatches a REAL builder
Section (real threads, Legs/rotation allowed) against the spec files, then goes straight to post-build — the
scheduler reads `build_path` to SKIP `codex_review`, the Section's `review_agent`/`review_fix` children, and
the `master_review` group. Otherwise it is identical to a normal build. The `direct_build` thread-group kind
is dropped (folded into `section`).

### 7. Threads are dormant-resumable; delete all auto-resume sweeps (d7)

Threads are never deleted, closed, or locked — they are dormant-but-resumable. A dormant thread is woken ONLY
by (a) an operator message, or (b) a host event the thread explicitly subscribed to (CI/mergeability for the
`ship` thread). Delete all three sweeps (the 30-min reap's `driver.resume()` backstop, `SessionResumeSweep`,
`JobUnblockSweep`) and the relays/pipeline-awareness store. A thread that halts or awaits a human just sits
dormant, costing nothing. The one exception: a purely-machine thread (`codex_review`/`review_agent`/
`review_fix`/`master_review`) that ends WITHOUT `complete_thread` is woken ONCE, immediately, with a "your turn
ended without complete_thread" reminder — an event-driven nudge, not a timed sweep.

### 8. Radically simplified thread/job state; halts are per-thread, display-only (d11, d12)

`jobs.status` becomes the activity-level enum `scoping → planning → plan_reviewing → awaiting_approval →
building → master_review → ready → shipping → pr_open → merged`, plus `amending`, `blocked` (the
dependency-park state, retained), `cancelled`, `deleting`. It is derived from the latest active thread group +
the two product gates, persisted denormalized. `ready` = post-build thread active, awaiting the operator's
ship/preview/amend call. DROP `jobs.activity`, `jobs.halted`, the phase-preserving `jobs.halt` jsonb, and
`threads.condition` — a thread halting never halts the job. `threads.status` collapses to `{idle, done}`
(idle = dormant/resumable resting state; done = `complete_thread`/`terminal_record`) + a nullable, DISPLAY-ONLY
`threads.halt_reason` (`session_limit | error | …`) set on abnormal end, cleared on next turn start, that NEVER
drives auto-resume. There is no persisted `running`/`waiting` — "working" is a live runtime signal, avoiding
stale-`running` after a crash. Trigger `scoping → planning` LIVE off a `Write`/`Edit` tool event targeting
`/context/specs/**` in the planner's streamed tool events — no fs watcher (d14).

### 9. Destructive, resumable migration; no in-flight preservation (d8)

Generate the schema migration via the repo's TypeORM wrapper, then hand-edit it to move data inline (value
remaps BEFORE column drops/retightening; each statement idempotent so a mid-run failure resumes). In-flight
prod jobs need NOT be preserved (single-user private tool); the migration may error on genuinely malformed
legacy rows as long as it is re-runnable and never leaves the DB broken. Draining/abandoning in-flight jobs
across the cutover is acceptable.

### 10. `report_findings` tool for review_agent (d9)

Give `review_agent` a structured `report_findings` tool (a list of findings, reusing the existing
`ReviewFinding` shape so the downstream `review_fix` dedupe/fix plumbing consumes them unchanged) to call
INCREMENTALLY as issues are found, so long review sessions don't lose findings mid-stream. Review prompts drop
the example-response boilerplate — the tool schema is the contract; the review ends by calling
`complete_thread` (ties into the wake-on-stop nudge, rider 7).

### 11. Planning + plan-review collapse into one Planning group (d10)

The Planning thread group holds two threads: the `planner` (chattable) and the `codex_review` (read-only).
`review_plan` spawns/wakes the codex thread inside the SAME group; the planner↔codex dialogue loops within it.
This replaces ADR 0008's two separate `planning` and `plan_review` thread groups.

### 12. Heavy amend re-enters planning; triggerable by post-build or operator (d13)

Two amend weights. LIGHT amend = the `post_build` thread makes the change in its own session (`ready →
amending → ready`). HEAVY amend = append a NEW `planning` group (planner + codex) onto the SAME job & worktree
(no reset/checkout), status → `planning`, then re-run plan → plan_reviewing → awaiting_approval → building → …;
old thread groups/threads stay dormant, not deleted. The heavy path is triggerable EITHER by the post-build
thread proposing it via a tool (`propose_replan`, when it judges the change substantial or a big main-drift
rebase warrants a re-plan) OR by the operator directly — either way it re-enters the plan-approval flow.

## What this changes in ADR 0008

ADR 0008's containment model (`jobs → thread_groups → threads → messages`, plus `tasks` and `subagents`,
registry + `config jsonb` over per-kind tables) STANDS. This ADR replaces its orchestration model and
data-model vocabulary:

- **Thread-group kinds:** `build` → `section`; `ci` → `ship`; **drop** `plan_review` (its codex thread now
  lives inside the `planning` group, rider 11) and `direct_build` (folded into `section`; direct-ness is
  `jobs.build_path`, rider 6). Final set: `planning | section | master_review | post_build | ship`.
- **Thread roles:** `planning` → `planner`; `plan_review` → `codex_review`; `ci` → `ship`. Final set:
  `planner | codex_review | builder | review_agent | review_fix | master_review | post_build | ship`. The
  `laneKind:'main'` notion is retired (there is no Main lane); `post_build` + `ship` flip to
  `operatorInput: true`.
- **Columns dropped:** `jobs.activity`, `jobs.halted`, `jobs.halt`, `jobs.pipeline_awareness`,
  `jobs.session_resume`, `jobs.direct_build_verification`, `thread_groups.condition`, `threads.condition`, plus
  the job-level `job_sandboxes` compaction-seed columns.
- **Columns added:** `jobs.focused_thread_id` (rider 4), `jobs.build_path` (rider 6), `threads.halt_reason`
  (rider 8).
- **Status enums:** `jobs.status` → the rider-8 enum; `thread_groups.status` → `pending | active | done`;
  `threads.status` → `idle | done`.
- **Orchestration:** ADR 0008's headless-driver + owed-wake sweep + the surviving `BrainGateway` wake surface
  are superseded by the scheduler + dormant-resumable + wake-on-stop model (riders 1, 7); its `direct_build`
  kind (0008 rider 8) is superseded by rider 6.

## Consequences

**Positive:**

- No context blow-up: each thread is a small, purpose-seeded session; no ever-growing Main context, no
  compaction-continuation leak.
- Radically smaller state surface: one halt overlay (`threads.halt_reason`, display-only) replaces
  `activity`/`halted`/`halt`/`condition`; `jobs.status` alone carries phase.
- No timer spam: dormant threads cost nothing until an operator or a subscribed event wakes them.
- Isolated, legible failures: a halt shows on the thread that halted; there is no relay bouncing it into an
  overloaded Main.
- Uniform pipeline: direct build is a real Section, not a special inline path; the scheduler drives one model.

**Negative / costs:**

- One destructive, one-way migration (rider 9); in-flight jobs are abandoned across the cutover.
- Validation is temporarily absent (rider 5): between this PR and the follow-up, the only gates are the two
  product gates (plan approval + ship) — agents self-report `complete_thread` ungated.
- The `brain/` module + `AgentSessionManager` keep the legacy "brain" name despite now being a per-thread
  session runner — a naming rough edge until a later cleanup.
- Per-thread prompt engineering (lean handoff packets, tuned per-role seeds) remains deferred to a follow-up;
  thread seeds reuse shared system prompting for now.

## Alternatives considered

- **Keep the persistent brain, just trim the relays/sweeps.** Rejected — the always-growing single session
  was itself the fragility (context blow-up, compaction leak); trimming its satellites leaves the root cause.
  d1 is a one-way door precisely because it changes the execution model, not just its accessories.
- **Split backend + web across two PRs with back-compat shims.** Rejected — backend + web share the read
  model, so a split breaks `main`'s console between merges; d3 delivers one atomic PR instead.
- **Keep validation gates in place, gated off behind a flag.** Rejected — d5 wants a clean slate so the
  follow-up designs validation without inheriting the old judge's assumptions; a flag would leave dead gating
  paths and a false sense the old system still works.
- **A dedicated fs watcher on `/context/specs` for `scoping → planning`.** Deferred as a later fallback — d14
  reuses the existing planner tool-event stream (lower infra) to detect the first spec Write live.
- **Preserve in-flight jobs across the migration.** Rejected — single-user private tool; a data-preserving
  migration of the halt/relay overlay onto the new shape is far more complex than draining (d8).

This ADR is the standalone reference for the host-scheduler / per-thread-session model; ADR 0008 remains the
historical record of the original thread-group introduction, with the model now living in
`backend/src/app/ARCHITECTURE.md`.
