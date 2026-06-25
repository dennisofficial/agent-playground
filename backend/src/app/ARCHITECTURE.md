# Atlas — architecture & the thread/session model

> **Canonical, read-first.** This is the source of truth for how Atlas is *modelled*. Companions:
> `../../../CLAUDE.md` (product model + conventions), `ATLAS_V2.md` (deep detail + build history — but
> its module/table names predate the org→repo→thread rebuild; trust this file for the model),
> `TUNING_HANDOFF.md` (open tuning items), `../../../web/BACKEND_GAPS.md` (web API gaps).
>
> All code paths below are relative to `backend/src/app/`.

**Status legend:** ✅ Built (matches code today) · 🟡 Partial / diverges from intent · ⛔ Planned (not built).
Where intent ≠ wiring, both are stated — this doc's job is to describe reality, not the aspiration.

---

## 1. The model in one paragraph

Atlas turns a **request** — a human message *or* an automated event — into a reviewed **PR**. The unit
of work is a **thread**. A thread is meant to be its own git branch, its own sandbox, and its own
*continuous* Claude Code session — **the thread brain** — which scopes, grills, locks decisions, proposes
a plan, and steers. Once a plan is approved, a deterministic **driver** ("the harness takes the wheel")
walks the plan section-by-section, running each phase as a **separate, fresh, throwaway** Claude session
you can watch live. **There is no central "Atlas" persona.** "Atlas" *is* the thread brain, and the thread brain *is*
the **main Claude Code session running inside that thread's sandbox** — when you open a thread and type,
you are talking directly to that session (its system prompt literally opens with *"You are Atlas"* —
`brain/agent-session-manager.service.ts:56`). Everything else — the driver, the intake guards, the web
surface — is host-side plumbing wrapped around that one session; a thread's own brain is the only
conversational agent it has. An automated event doesn't talk to a central brain either; it **spawns a new
thread** and (intended) becomes that thread brain's opening message.

## 2. Product model — Organization → Repos → Threads  ✅

The tenancy hierarchy (detail in `CLAUDE.md`):

- **Organization** (`organizations`) — the tenant; `org_id` scopes every `app` table.
- **Repo** (`repos`) — a connected GitHub repo; the conversation container (the old 1:1 `channels` is gone).
- **Thread** (`threads`, real uuid) — a conversation/work unit on a repo; `messages` is its durable log.

A thread **is the build unit** — the former separate `jobs` layer was collapsed into `threads`
(`brain/job-dispatcher.ts:7`).

## 3. The thread = a branch + a sandbox + a session

**Intended:** every thread owns —

- a git **branch** `atlas/thread-<id-slice>` (stored on `threads.feature_branch`),
- a durable **worktree** (the engine's `cwd`),
- a per-thread **Docker sandbox** container,
- a continuous **brain session** (`thread_sandboxes.session_id`).

The code that realizes all of this is `ThreadLifecycleService.createThread` → `provisionSandbox`
(`driver/thread-lifecycle.service.ts:80`, `:105`; branch cut at `:331`, recorded on the thread at `:349`).

🟡 **Provisioning is now lazy, not eager.** The live create/seed paths still insert bare rows, but the
thread brain **provisions on the thread's first turn** (`ensureProvisioned`), so a thread gets its branch +
sandbox + session the moment you talk to it. See **§8**. (An event-seeded thread that reaches the driver
*without* ever taking a brain turn is the remaining edge — §8.)

## 4. The two session types — the heart of the model

There are **two completely different kinds of Claude Code session**. Conflating them is the #1 source of
wrong mental models in this codebase (and in the UI mockups, which label the phase view *"not the thread's
brain"* for exactly this reason). The **thread brain is the thread's main, continuous Claude Code session** —
the one the operator talks to (§1). The phase workers are short-lived sub-sessions the *driver* runs to
build the approved plan; they are not the thing you converse with.

| | **Thread brain** | **Phase worker** |
|---|---|---|
| Count | **One** per thread, *continuous* | **One per pipeline phase**, fresh & ephemeral |
| Session state | Resumes `thread_sandboxes.session_id` **every turn** | `phases.session_id`; resumed **only** on a mid-turn halt |
| Role | intent → grill → lock decisions → propose plan → **steer** | execute **one phase** of the approved plan |
| System prompt | **custom plan mode** (NOT the SDK's native `ExitPlanMode`) | standard coding agent |
| Tools | 7 host-side tools (below) | normal coding tools (Read/Edit/Bash/…) |
| You talk to it via | the thread **Conversation** (`say`) | the phase **transcript** (*interject* — ⛔ not built) |
| Code | `brain/agent-session-manager.service.ts:101` (`handleChatTurn`) | `runner/turn-runner.service.ts:66` (`runTurn`) |

**Thread brain — the 7 host tools** (built in `agent-session-manager.service.ts` `buildTools`):
`get_pipeline_state`, `get_decision_record`, `recall`, `remember`, `submit_plan`, `dispatch_build`,
`create_thread`. It can **read** pipeline state but does not itself drive the build; `submit_plan` →
approval card; `dispatch_build` is gated on operator approval. It is genuinely continuous: each turn resumes
the same `session_id` (`:114`, persisted at `:162`), so it remembers the grilling, the locked decisions, and
the plan across turns and even host restarts.

**Inter-thread dependencies (`create_thread`).** ✅ The brain can spin off a follow-up thread on the same
repo — optionally **dependent** on the current one (`threads.blocked_by_thread_id`, self-FK `SET NULL`). A
dependent is created `status='blocked'` and *frozen* (no brain turn; `say` returns 409) until the
predecessor's PR **merges**; the merge poll (`pollPrClosures`) then unblocks it and **auto-starts** its
brain on the stored `seed_message` (the brain-authored opening intent — also the durable "not yet
delivered" marker, cleared only on a durable start, retried by `deliverPendingSeeds`). A predecessor that's
deleted / fails / is denied instead *frees* its follow-ups with a notice (no auto-start). A dependent
always cuts from the repo **default** branch (= the merge target), so the tool rejects a dependency off a
custom-base thread. See `brain/agent-session-manager.service.ts` (`create_thread`, `startSeededThread`,
`onDependencyResolved`) + `driver/thread-lifecycle.service.ts` (`pollPrClosures`, `resolveDependents`).

**Phase workers** — each pipeline phase (plan → review → execute → auto-fix) runs as a *fresh* session so
context can't rot across phases. They're observable **live** via event streaming to the SSE surface
(the Transcript / Diff / Logs view). A phase worker is *not* the thread's brain — interjecting into one
(when built) steers that one coding session, not the thread's intent.

## 5. The pipeline / driver — the hands  ✅

After a plan is approved, **`SectionDriver`** takes the wheel: a deterministic, legible, **resumable**
loop that walks the planner-emitted sections in order. Each section does
`plan → review → gate → execute phases → auto-fix → handoff`; sections stack on the **one** feature branch;
**one PR per thread** (`driver/section-driver.service.ts`). It is a plain `await`-each-step loop, **not an
implicit FSM** — explicit `step`/`status` rows exist *only* so `resume()` can re-enter after a restart.

The brain and the driver run **concurrently**: you can keep talking to the brain while the driver builds.
But note the brain currently has **no tool to alter a running build** — its 6 tools are read/plan/dispatch
only — so live "steering" beyond observation is ⛔ not built (see §6, §8).

## 6. Inputs & steering surfaces

How a thread is driven, and what is actually wired:

| Input | Route | Target | Status |
|---|---|---|---|
| Operator message | `POST …/threads/:id/say` | thread brain (`handleChatTurn`) | ✅ (provisions the sandbox lazily on first turn — §8) |
| Plan verdict | `POST …/threads/:id/approve` | approval gate → dispatch on approve | ✅ |
| Live observability | `GET …/repos/:id/events` (SSE) | outbound stream (chat + cards + phase events) | ✅ |
| Automated event | `POST /ingress/github`, `/ingress/webhook` | event intake → **spawns a thread** (§7) | ✅ |
| Resume a paused build | port + driver subscription + `POST /test/resume` | `SectionDriver.resumePaused` | 🟡 web controller endpoint missing |
| Interject a running phase | — | phase worker | ⛔ not built |
| Pause / revert phase / auto-advance | — | driver | ⛔ not built |
| NL steering ("pause", "undo that phase", "simplify the rest") | — | maps to the above | ⛔ not built |

`/web/resume` exists as a surface port (`web-surface.ts` `requestResume`) + a driver subscription
(`driver/driver.module.ts`) + a test-bridge route, but **no web controller endpoint** invokes it yet.

## 7. Event intake — the untrusted firehose

An automated event (CI/CD failure, GitHub/PostHog/Sentry webhook) becomes a **thread**. Four **mechanical
guards** run first — they exist because the firehose is *hostile and noisy*, and have nothing to do with
threading, so they **stay** regardless of the rework below:

- **dedup + rate-limit**, no LLM — a Stripe re-delivery or a Sentry storm must not each pay a turn
  (`stimulus/event-filter.service.ts`).
- **repo routing** — a webhook carries no `org_id`, so `owner/repo` → connected repo
  (`stimulus/project-routing.service.ts`).
- **untrusted fence** — the body is DATA, never instructions (`stimulus/untrusted-content.ts`).
- **seed a thread** + first message + stimulus row, with a DB unique-index dedupe backstop
  (`stimulus/stimulus-store.service.ts:69`).

**Today (slated for rework):** events route through a unified `Stimulus` currency + a `StimulusRouter`
demux + a *second, event-only LLM brain*, `EventTriageService` (ignore / park / auto-dispatch). This is a
leftover from when Atlas was one central brain — and `StimulusRouter`'s only job is to immediately demux
the union back apart by `kind`, which is the tell that the union earns nothing.

⛔ **Intended direction:** there is only **one brain per thread — its session**. An event should be just the
**opening message** to a freshly-spawned thread's brain, mechanically identical to a human's first message.
Keep the four mechanical guards; **drop** the `Stimulus` union + router + the second brain. The security
control then becomes the **same approval card** every plan already passes through (untrusted → the brain
proposes → a human approves before the harness builds).

**Open decision (deferred — why triage still exists):** today a "clean" event **self-approves** and
dispatches an autonomous bugfix with **no human** (`brain/event-triage.service.ts:138`). The rework must
decide whether to keep an autonomous (no-human) lane or require approval for *every* event-spawned plan.
Until that's settled, the triage lane stays.

## 8. Known divergences & tech debt

### Provisioning — ✅ closed on the brain path (06-24; live-browser validation pending)

The live creation paths still insert **bare thread rows** with no sandbox/branch —
web `WebSurfaceController.createThread` (`surface/web-surface.controller.ts:155`) and
event `StimulusStoreService.seedEventThread` (`stimulus/stimulus-store.service.ts:69`). The fix landed on the
**first-turn brain path**: `handleChatTurn` now **lazily provisions** the thread's branch + sandbox +
session via `lifecycle.ensureProvisioned` before the turn runs (posting *"Setting up an isolated workspace…"*
so the first turn isn't a silent ~30s wait) — `brain/agent-session-manager.service.ts:102-138`. So chatting a
freshly web-created thread now spins everything up on demand; the brain no longer dead-ends with *"Please
create a thread via the web app…"* (that line is now only an unexpected-state fallback). Code-complete, full
suite green; **not yet live-browser validated**.

**Still open:** an **event-seeded** thread that reaches the driver *without* ever taking a brain turn skips
the lazy provision — `ensureSandbox` then takes the **legacy fallback** and cuts `atlas/${kind}-${id}`
(e.g. `atlas/feature-1a2b3c4d`), **not** `atlas/thread-<id>` (`driver/section-driver.service.ts:828`).

**Fix (not done here):** route the live create/seed paths through `ThreadLifecycleService`, or provision
lazily on the thread's first turn.

### Other gaps

- **Branch not surfaced in the API** — `threads.feature_branch` is real, but the thread list/detail DTOs
  omit it (`web-surface.controller.ts`), so the UI's branch chip has no backing field yet.
- **Operator steering not built** — interject / pause / revert / auto-advance / NL-steering
  (also noted in `ATLAS_V2.md` §10.5).
- **`/web/resume` web endpoint missing** — the plumbing exists; the route doesn't.
- **Phase transcript / diff / logs** are partly placeholder/derived in the web app
  (`web/BACKEND_GAPS.md`).
- **Event-triage second brain** — pending the §7 rework.

## 9. Durability — how a halt resumes  ✅

The contract: a halt **continues the same engine session**, it doesn't spawn a fresh one. The key fix is
persisting the `session_id` at turn **start** (the first NDJSON frame), not just at success — so a mid-turn
crash still leaves a resume handle. Boot `SectionDriver.resume()` re-drives `running` jobs; a per-thread
sandbox cold re-attach prepends a `SANDBOX_RESET_NOTICE` so the resumed session re-establishes runtime it
can no longer trust; the thread + branch survive a restart via the shared `.git`. A 401 mid-turn →
`paused` (durable) → fix creds → ping resume → the same session continues. Full detail in `ATLAS_V2.md` §9.
(✅ for any thread on the provisioned path — see §8 for the caveat.)
