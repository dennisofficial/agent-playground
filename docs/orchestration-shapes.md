# Local Atlas — orchestration model

Running record for the orchestration wayfinding. Supersedes the three-shapes version of this
doc. Edit freely.

## Frame

Atlas is a **multi-session orchestration harness** over the Claude Agent SDK (and Codex, and
whatever else). It does not replace the agent SDK's standard features — it wraps them. The
value it adds is the part Claude Code can't do: **many sessions serving one job, aligned by a
shared folder, with context engineering across the seams.**

Target: the **existing cloud harness** — NestJS host, web UI, sandbox pods, Postgres. The local
TUI idea was explored and dropped as out of scope: it was a second delivery surface for the
same orchestration model, and the problem it was meant to solve (reviewing code in a real IDE
with working LSP) is better solved by **exposing SSH into the sandbox for remote development**
with Zed / JetBrains Gateway. That is an infra dependency of the review workflow, tracked
separately from orchestration.

Everything settled below is surface-agnostic — it survived the local detour unchanged.

## Settled

### Job

A job is created empty — no `firstMessage`. Fresh job, fresh thread, **no session yet**. Job
kind is an *outcome* discovered during intake, not an input.

### Two structural levels: group → thread

`stage` is dropped. A **group is one phase instance**; `group.kind` *is* the phase. Only
`build` ever emits N groups (one per workstream); everywhere else the group is a formality,
which is fine — it costs one row.

A **wave** is a maximal contiguous run of groups of the same kind. Derived, not stored — the
path is linear, so contiguity is exact.

```
job
├─ group #0  kind=intake
│   ├─ thread  role=intake
│   ├─ thread  role=research
│   └─ thread  role=spike
├─ group #1  kind=planning
│   ├─ thread  role=planner  "implementation"
│   ├─ thread  role=planner  "backend"
│   └─ thread  role=planner  "frontend"
├─ group #2  kind=build  title="infra"      ← drafted during planning
│   └─ thread  role=builder  leg 1
├─ group #3  kind=build  title="backend"
│   ├─ thread  role=builder  leg 1
│   └─ thread  role=builder  leg 2          ← context pressure
├─ group #4  kind=build  title="frontend"
│   └─ thread  role=builder  leg 1
├─ group #5  kind=post_build
│   └─ thread  role=post_build
└─ group #6  kind=ci
    ├─ thread  role=ci_ship     closed after PR
    └─ thread  role=ci_events   all subsequent events route here
```

Why group-over-stage: a **drafted build group needs somewhere to live before it has any
threads**. A workstream tag on a thread can't represent a workstream that hasn't started.

### The guided path — LOCKED

Fixed vocabulary, dynamic sequence, **no conditional edges**. Phases repeat and loop.

```
intake        → planning | design
design        → planning
planning      → build | direct_build | design
build         → master_review | planning
direct_build  → post_build
master_review → post_build
post_build    → planning | design | ci
ci            → (absorbing — no exit)
```

Earlier drafts had a conditional edge out of `build` whose predicate nobody could pin down.
Splitting the node into `build` (thorough) and `direct_build` (fast path) moves that decision to
plan-approval time and makes the transition table a plain lookup. **`build` threads spawn auto-review
children when they close and the wave always goes to master review; `direct_build` threads spawn none
and skip master review entirely.**

The price, accepted knowingly: the graph now encodes closing *policy* alongside work, so every
downstream consumer carries two build cases forever; and thoroughness is a **per-wave** choice, so a
plan with one trivial and one hairy workstream must pick one setting for both.

Both backward edges exist. `build → planning` lets a builder replan while the discovery is fresh
(mid-wave abandonment rules pending). Routes back into `design` from `planning` and `post_build` make
a UI rethink mid-job normal rather than exceptional, now that design output lands in shared `context/`.

### Termination — nothing terminates

There is no terminal phase and no terminal transition. `ci` is absorbing because PR events keep
arriving indefinitely. A **merged PR** surfaces in the UI as `merged` — read off the PR, never a
status anyone sets — and a **3-day last-active TTL** auto-archives. Termination is a derived display
state plus an idle sweep, on a different axis from the phase graph.

Consequence: `EJobStatus` must shrink to pure lifecycle; its pipeline-mirroring members
(`planning`, `plan_review`, `awaiting_approval`, `awaiting_ship_review`, `amending`) are now phase
concerns living on `thread_groups.kind`.

### Threads are history, not workers

`thread_groups` and `threads` are **records**. A rotation retires the old thread; opening a job lands
on the latest active thread (`Job.focusedThreadId`, already a column). Parallelism is not ruled out
but is minimal — review fan-out is the one real case, and those children are non-addressable, so the
single-cursor rule stays exact: one active *chat*, plus workers underneath it.

### Build structure: draft → approve → activate

Build groups are **authored incrementally during planning** as a byproduct of the planning
threads doing their work — they exist as drafts. **Human approval of the plan is what freezes
them** and activates the wave. The approval gate you already wanted doubles as the structural
commit point.

So build structure is neither materialized-from-a-manifest nor created by runtime agent tool
calls. It is drafted, reviewed as part of the plan, then followed.

### Four thread-creation triggers

One creation path, four things that pull it:

| # | Trigger | Where it applies |
|---|---------|------------------|
| 1 | **Context pressure** → auto-rotate a leg | build, master_review |
| 2 | **User** → open a thread | intake, design, post_build; "ship" → ci |
| 3 | **Agent** → scaffold siblings / draft build groups | planning |
| 4 | **External event** → CI event with no open thread | ci |

Trigger 1 is already implemented in `host_old/driver/leg-rotation-watch.ts`.

Note the tool gap: `handoff` continues work and `complete_thread` ends it, but **neither
branches**. Trigger 2 and 3 need a way to open a *sibling* thread with a different role.

### Per-phase behaviour (from scratch.md)

- **intake** — OPEN. Parallel chats? user-created threads? Exploration spawns research /
  spike / prototype threads as wayfinding proceeds.
- **design** — single thread, or user-controlled. Parity with `claude.ai/design`; possibly just
  a thread that writes a handoff for `claude.ai/design` and ingests the returned zip.
  Reference: the open-source `open-design` package.
- **planning** — the first thread scaffolds the rest (implementation / infra / backend /
  frontend plans). Planning threads draft the build groups as they go.
- **build** — groups fixed at plan approval; threads are legs, auto-rotated on context
  pressure.
- **master_review** — legs, auto-rotated on context pressure. Threads: live test → store
  findings → fix findings.
- **post_build** — user-controlled. Spin up preview, minor amendments, or rewrite / switch
  lanes. Can send the job back to planning.
- **ci** — first thread created by the user clicking "ship" on a post-build thread: rebase,
  create PR, push, then the thread closes. When CI events arrive (comments, failures, merge
  conflicts) a new thread is created to address them, and all subsequent events route into
  that thread.

### Enum reconciliation — settled

```
EThreadGroupKind   + intake  + design  − plan_review     (direct_build KEPT)
EThreadRole          plan_review KEPT · review_agent KEPT · review_fix KEPT
EJobStatus           shrinks to lifecycle only
```

`plan_review` is demoted from phase to **role** — a Codex review thread scaffolded as a sibling inside
the planning group. As a phase it had one thread and one exit and never forked; as a role it can also
run per-plan, so the backend and frontend plans each get reviewed.

`review_agent` / `review_fix` stay **roles**, spawned as children inside a build group when a builder
thread closes. Legacy already solved the "threads the user must not chat with" problem in
`host_old/thread-kind/registry.ts` via per-role `execution: 'child'` + `operatorInput: false`. They
are real threads with real sessions — **not** SDK Task-tool subagents, whose context windows the host
cannot rotate, and the builder is closing precisely because it is full. `Thread.parentThreadId`,
`Job.focusedThreadId` and `EMessageAudience` all already exist in the schema, unused, for exactly this.

Roles for `intake` (research / spike / prototype) and `ci` (ship / events) are not settled yet.

## Open

- **Intake shape** — the phase with the least clarity, and the first one that runs.
- **Who fires a transition** — the graph says what is legal, not when or which. Every edge is
  unconditional, so "which edge" is always a *choice*, never a computed predicate. Also: what fires
  the review-child join, and does a fix go back to the latest builder leg or into a new thread?
- **Parallel build groups vs one job workspace** — a job has one workspace
  (`$ATLAS_DATA/workspaces/<jobId>`, hostPath-mounted into the pod). infra / backend / frontend
  would edit it at once. Worktrees? Serialize? Single writer?
- **The shared folder** — layout, schema, who reads and writes what. This is the magic and it
  is entirely unspecified. Now known to hold at least the design bundle, under `context/`.
- **Handoff payload** — what a handoff note contains and how the next leg is seeded.
- **Tool surface** — the final list of agent-facing tools.
- **Agent-agnostic** — which engine/model/effort per role, and what that binding looks like.
- **Mid-wave abandonment** — `build → planning` fires with the wave in flight; what happens to the
  completed, unstarted, and triggering groups.
- **Design round-trip** — how a parked job learns its bundle arrived; no upload path into a job
  exists today.

### Context-pressure detection — signals settled, policy open

Claude gives occupancy **free** on every assistant message (`input + cache_read + cache_creation` on
the latest top-level message *is* current occupancy, since the transcript is resent each round-trip),
plus an authoritative on-demand `Query.getContextUsage()` — available today, since `RunnerService`
already drives the SDK in streaming-input mode, just never called. **Codex has no mid-turn signal at
all**; usage arrives only at `turn.completed`, so an engine-agnostic policy is turn-boundary-granular.

Legacy nudged at 150K then every +25K, monotonic, skipping unknown-occupancy (Codex) turns and
subagent windows — and it **injected a nudge into the conversation** rather than cutting the leg.

Two live problems for the policy: the SDK **auto-compacts by default** and nothing listens for
`compact_boundary`, so compaction and rotation race for the same event; and `rate_limit_event`
(already harvested in `turn-dispatcher.service.ts`) is *account budget*, not context fullness — don't
conflate them.

## Out of scope

- **Local TUI harness** — a second delivery surface for the same model; the review problem it
  solved is handled by SSH-into-sandbox instead.
- **SSH remote development into the sandbox** — the actual fix for IDE/LSP review. Real and
  needed, but it is infra, not orchestration; its own effort.
- **System-prompt module** — building the system prompt per job kind and group kind. Explicitly
  deferred; depends on the phase vocabulary landing first.
- **Non-repo pipelines** — scheduled analytics, ops, storefront management. The guided path
  should not hardcode "build", but no second path gets defined here.

## Prior art

Legacy `host_old` implemented a single hardcoded pipeline:

- `thread-group-kind/registry.ts` — group kinds declare `roles` with min/max and a `spawnAt`
  event: `job_start → plan → dispatch → after_build_thread_groups → after_master_review →
  after_ship`.
- `thread-kind/registry.ts` — thread roles bind agent prompt, engine (claude/codex), reasoning
  effort, input policy, runner.
- `driver/leg-rotation-watch.ts` — context-pressure leg rotation.
- `driver/worktree-provisioner.service.ts` — per-lane git worktrees.
- Agent tools: `complete_thread`, `record_leg_handoff`, `propose_plan`, `dispatch_build`,
  `finalize_build`, `request_operator_input`, task CRUD.

Current v3 (`backend/src/host`) carries the enums and the `job → thread_groups → threads`
tables, and `TurnDispatcherService` runs a turn against one thread with session resume — but
**there is no advancement logic at all**. Nothing creates a second group, nothing rotates legs,
no host tool surface.
