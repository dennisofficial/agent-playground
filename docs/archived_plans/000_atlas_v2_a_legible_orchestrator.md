# Atlas v2 — a legible orchestrator (brain · hands · spine · intakes)

## Context

The current system (`backend/src/harness/`) tries to simulate a *team of autonomous AI employees chatting in Slack*. That framing is the disease. The genuinely fragile parts are all in the orchestration-as-social-simulation layer — the conductor-as-Atlas turn-FSM, the respond/skip gate classifier, six phantom specialist personas, the board-relay bus — and in `pipeline-runner.service.ts` (1,849 LOC), an **implicit** state machine that re-enters itself by reading `status` enums across five Postgres tables on racing async `onSessionUpdate` signals. Add the optional-but-heavy 7,200-LOC Docker/daemon sandbox system, and the whole thing is too fragile to trust.

What's actually solid (per exploration): the **execution primitives** — engine adapters (`engines/`), git/PR (`worktrees/`, `daemon/git`), the session turn-runner (`sessions/`), memory (`memory/`), and approval cards (`slack-app/approvals/`). Those are the hard, battle-tested parts and are *not* the source of pain.

**Goal:** a v2 that does exactly what Dennis does by hand — chat to shape a feature → plan → Codex review → revise once → approve → execute in sections/phases → self-review → one PR → PR-review — and *also* reacts autonomously to notifications (CI failure, merge conflict, GCP/PostHog alert) by driving a fix to a PR. Dennis only ever reviews **system decisions and PRs**. The orchestration becomes a **deterministic pipeline you can read top-to-bottom**, with an LLM brain that only decides *whether/what*, never *how*.

This is a from-scratch rebuild in a new module beside the old one, reusing the primitives, deleting the orchestration + sandbox layers. Clean-slate persistence (old DBs may be dropped). No boards/backlogs.

---

## The v2 model (locked)

**Brain vs. hands**
- **Atlas = brain.** Conversational + reactive. Small tool surface. Reads a stimulus, decides ignore / ask / dispatch. Does *not* sequence builds.
- **Pipeline = hands.** A plain deterministic `async` driver (not an agent). Walks a planner-emitted list of sections/phases by `await`ing each step. One readable file. The "dynamism" is data (the list), not improvised control flow.

**Tenancy / structure**
- `Tenant` (Slack workspace, = `team_id`) ⊃ `Projects` (GitHub repos) ⊃ `Channel` (1:1 per project) + per-feature execution (local worktrees in MVP; Docker later).
- **One channel per project** — notifications route to the project's channel; decision-records and memory scope to it; collapses to a single channel for one-repo tenants.

**Work model**
- A **job = an ordered list of sections** (e.g. backend → frontend → devops). A bugfix is a 1-section / 1-phase job; a feature is many — same driver.
- **Two-level planning:** (1) *upfront, once* — Atlas grills Dennis → a **locked decision record** (the architecture/system calls) + the **high-level section list**, approved once. (2) *per-section, just-in-time* — a detailed phased plan generated *inside* the decision record + the prior section's handoff. **Phases lock once planned.**
- **Sections stack on ONE feature branch.** Phases run as **sequential fresh sessions** on that branch — fresh context per phase (stay <300k, avoids hallucination), shared checkout so later sections build on earlier code. Isolation lives at the **feature** level (parallel features = separate worktrees), not the phase level.
- Per section: `plan → Codex review (one loop) → revise → [gate] → execute phases → best-practices review (auto-fix) → handoff`. After all sections: **PR-tail review (auto-fix) → ONE PR per feature.**

**Gates / autonomy (adaptive — model C)**
- Dennis approves the high-level plan + decision record **once** upfront. Sections then auto-run.
- A section planner **parks & asks async** (in the thread) only when it hits an **always-ask** decision class *not* already covered by the record. Otherwise it proceeds; its detailed plan is still **posted for visibility** (override anytime, but it doesn't block).
- **Always-ask:** data model/schema, public/cross-service API contracts, new deps/libraries/services, infra/topology, cross-cutting patterns (auth, caching, state, concurrency, error-handling), one-way doors.
- **Never-ask:** internal structure, naming, file placement, test layout, refactor mechanics, anything determined by a locked decision.
- **Autonomous (notification-triggered):** clean stimulus (no always-ask touched) → straight to PR; always-ask → park & ask. The decision-class boundary doubles as a **security control** (see below).

**Stimulus / intake**
- One normalized typed envelope: `Stimulus { source, trust, body, routing, dedupeKey?, severity?, author? }`. Both chat and notifications enter the harness as Stimuli. Chat = `trust:human`, `routing:originating-thread`. Notification = `trust:untrusted`, `routing:project-channel`, `dedupeKey`.
- **Intake adapters** normalize external events → Stimulus (MVP: Slack inbound, GitHub webhook, generic webhook). New sources are thin adapters; the core never changes.
- **Mechanical pre-harness filter** (no LLM): dedup (by `dedupeKey`) + rate-limit, so the firehose doesn't pay an Atlas turn per duplicate (esp. PostHog storms grouped to one issue).
- **Untrusted content is DATA to triage, never instructions.** Atlas is hard-told this; the always-ask gate guards against injected "go change X."
- Per surviving stimulus → Atlas **triage turn** → ignore / ask / dispatch.

**Chat / threading**
- Notifications **announce in the main timeline**; each job's detailed chatter lives in a **thread** off the announcement (main stays readable; you can collapse to first+last line).
- **Many histories = one `messages` table partitioned by `thread_id`.** Threads are isolated (context hygiene — same reason phases reset). **Cross-thread coherence = shared memory only**, never transcript sharing. Reuse layered memory tiers.

**Surfaces**
- **Slack first** (reuse the shipped adapter) bound via the `CHAT_SURFACE` port.
- **NEW: an agent-facing programmatic/terminal surface** — a `ChatSurface` adapter I (or a build sub-agent) can call to send messages to Atlas and read its replies, to drive/validate the system end-to-end without Slack.

---

## Scope

**IN (full vision minus Docker):** multi-tenant (`team_id`); channel-per-project; Slack + agent-facing surfaces; stimulus intake (Slack + GitHub webhook + generic) with dedup/rate-limit; Atlas brain (triage, upfront grill → decision record + section list, dispatch); the deterministic section/phase driver; Codex plan-review loop; per-section + PR-tail self-review auto-fix; one PR per feature; reused primitives (engines, local git/PR, session runner, memory, approval presenter). Fresh minimal Postgres schema. **No boards/backlogs.**

**OUT (explicitly deferred):** Docker sandboxes (MVP runs on **local git worktrees**; redo is a later planning round). Cross-project *reference* repo access (channel can read other repos) — **note for the sandbox rework, not now.** Email/Sentry/PagerDuty intakes (later adapters into the same intake).

---

## Architecture

New module **`backend/src/atlas/`** holds all new orchestration; it imports the trusted primitives as libraries.

**Reuse (call, don't rewrite)** — decouple from approval/persona/standup where noted:
- `harness/engines/` — `WorkerEngine` port + claude/codex engines (reuse as-is; stub `IAgentToolsProvider`).
- `harness/worktrees/WorktreeService` — local git, branch, worktree-per-feature, `open_pr`.
- `harness/sessions/` — `SessionRegistry` + `SessionRunnerService`; make approval/standup/persona/git-preamble **optional callbacks** so the driver passes engine + system prompt directly.
- `harness/memory/` — pgvector facts, dedup judge, worklog, checkpointer (reuse what fits the fresh schema).
- `slack-app/approvals/` — `PlanProposalPresenter` port + approval-card rendering (`approval-blocks.ts` is pure).
- `harness/surface/` — `CHAT_SURFACE` port + `SurfaceBridge`; `slack-app/slack-surface.module`.
- `harness/projects/` — projects + encrypted github tokens + `GithubApiService`.

**Delete (at parity):** `harness/conductor/` (Atlas-FSM — rebuilt minimal in `atlas/`), `sessions/pipeline-runner.service.ts` + section/phase FSM tables, `harness/gate/`, the employee roster/persona system, the board (`BoardStore`/team board/`suggest_task`/relay bus), and the entire Docker sandbox stack (`harness/workspaces/` + `daemon/`). Old DB schema may be dropped.

---

## Build decomposition (Opus sub-agents, dependency-ordered)

- **W0 — Foundation.** `src/atlas/` Nest module skeleton; fresh minimal Postgres schema + migrations (clean slate); core domain types: `Stimulus`, `Thread`/`Message`, `Job`, `Section`, `Phase`, `DecisionRecord`, `SessionRef`.
- **W1 — Primitive decoupling.** Make `SessionRunnerService`/engines callable from the new module without approval/persona/standup coupling (optional callbacks). Local-git path confirmed (no daemon).
- **W2 — Stimulus + intake + filter.** Envelope; Slack inbound + GitHub webhook + generic webhook adapters; mechanical dedup/rate-limit; untrusted-content contract.
- **W3 — Atlas brain.** Triage turn (ignore/ask/dispatch); upfront grill → decision record + section list; the small tool surface; dispatch.
- **W4 — Section/phase driver.** The deterministic, resumable `async` pipeline: plan → Codex → gate → execute phases (fresh session/worktree per feature) → review → handoff → one PR. Explicit step-state rows (no implicit status-FSM).
- **W5 — Decision-class gate.** Always-ask vs never-ask classifier; park/ask-async in-thread; visibility posting.
- **W6 — Surfaces + threading.** Slack binding + announce/thread model; **the agent-facing programmatic surface** for driving Atlas in tests.
- **W7 — Review passes.** Per-section best-practices review + PR-tail review, with auto-fix.
- **W8 — Deletion.** Remove old orchestration + sandbox/daemon once parity reached.
- **W9 — Wiring + verification.** Compose the module; end-to-end drive via the agent-facing surface; tests.

Dependencies: W0 → W1 → {W2…W7 largely parallel} → W9; W8 after parity.

---

## Fresh persistence (minimal)

Tables (Postgres, clean slate): `teams` (tenant) · `projects` (repo + base branch + token ref) · `channels` (1:1 project) · `threads` + `messages` (partitioned by `thread_id`) · `stimuli` (with `dedupe_key`) · `jobs` · `sections` · `phases` (explicit resumable step state) · `decision_records` · memory (reuse pgvector facts + checkpointer). No `board`/`team_tasks`.

---

## Verification

- **Drive Atlas via the agent-facing surface (no Slack needed):**
    1. Send a feature request → confirm Atlas grills → writes a decision record + section list → Dennis-approval gate.
    2. Approve → confirm per-section: plan → Codex pass → (no always-ask → proceeds; inject an always-ask case → parks & asks) → phase execution in a worktree → best-practices review → handoff.
    3. Confirm sections stack on one branch → PR-tail review → **one PR** opened.
- **Autonomous path:** POST a GitHub webhook stimulus (CI failure) → confirm dedup → triage → 1-section bugfix → PR; POST a duplicate → confirm the filter collapses it (no second job).
- **Security:** a stimulus whose body contains injected instructions → confirm it's triaged as data and any always-ask action parks rather than executes.
- **Unit tests:** stimulus normalization, dedup/rate-limit filter, decision-class classifier, the driver (deterministic + resumable across restart), triage.
- Typecheck + remaining suite green after deletions.
