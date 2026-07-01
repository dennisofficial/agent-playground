# Atlas — architecture & the job/session model

> **Canonical, read-first.** This is the source of truth for how Atlas is *modelled*. Companions:
> `../../../CLAUDE.md` (product model + conventions), `ATLAS_V2.md` (deep detail + build history — but it
> predates the org→repo→job rebuild AND uses the old vocabulary; trust THIS file for the model),
> `../../../web/BACKEND_GAPS.md` (web API gaps).
>
> All code paths below are relative to `backend/src/app/`.

**Vocabulary (post-rename — memorize this).** A **Job** is the CONTAINER (the unit of work: request → PR;
owns the branch, sandbox, PR, and one message log). A **Thread** is a BUILD LANE inside a job (a Main
planning lane + one per build track). A **Step** is a unit within a thread. DB: `jobs` / `threads` / `steps`
(+ `job_sandboxes`). The words "track" (→ thread) and "phase" (→ step) from older docs are gone. NOTE:
"session" below always means a **Claude Code / Agent-SDK session**, never a domain object.

**Status legend:** ✅ Built (matches code today) · 🟡 Partial / diverges from intent · ⛔ Planned (not built).
Where intent ≠ wiring, both are stated — this doc describes reality, not the aspiration.

---

## 1. The model in one paragraph

Atlas turns a **request** — a human message *or* an automated event — into a reviewed **PR**. The unit of
work is a **job**. A job is its own git branch, its own sandbox, and its own *continuous* Claude Code
session — **the job brain** — which scopes, grills, locks decisions, proposes a plan, and steers. Once the
plan is approved, a deterministic **driver** ("the harness takes the wheel") walks the plan's **threads**
(build lanes) in order, and you watch the build stream live. **There is no central "Atlas" persona.** "Atlas"
*is* the job brain, and the job brain *is* the **main Claude Code session running inside that job's sandbox**
— when you open a job and type, you talk directly to that session (its system prompt opens with *"You are
Atlas"* — `brain/agent-session-manager.service.ts:56`). Everything else — the driver, the intake guards, the
web surface — is host-side plumbing wrapped around that one session. An automated event doesn't talk to a
central brain either; it **spawns a new job** and becomes that job brain's opening (harness) message.

## 2. Product model — Organization → Repos → Jobs → Threads  ✅

> **Deployment model: private, not SaaS.** Atlas is a personal/private tool for Dennis and a small circle of
> close friends — **not** a commercial multi-tenant SaaS. The org/sandbox isolation below keeps friends'
> work separate (and is defence-in-depth), not a boundary for untrusted paying customers. Read
> "tenant"/"multi-tenant" as *private multi-workspace*. See `saas-credential-compliance` for why selling was
> ruled out (subscription credentials can't back a sold product; API keys too costly to resell).

The hierarchy (detail in `CLAUDE.md`):

- **Organization** (`organizations`) — the tenant; `org_id` scopes every `app` table.
- **Repo** (`repos`) — a connected GitHub repo; the conversation container (the old 1:1 `channels` is gone).
- **Job** (`jobs`, real uuid) — a conversation/work unit on a repo; `messages` is its durable log.
- **Thread** (`threads`, real uuid) — a BUILD LANE within a job (`thread_id`→`job_id` FK). The Main
  conversation lane + one thread per build track. **Steps** (`steps`) are the leaves within a thread.

A **job is the build unit** — the former separate `jobs`-vs-`threads` split was collapsed into one container
(`brain/job-dispatcher.ts`). The build sub-structure now lives in `threads` (was `tracks`) + `steps`.

## 3. The job = a branch + a sandbox + a session

Every job owns —

- a git **branch** `atlas/*` (stored on `jobs.feature_branch`), cut from a base branch,
- a durable **worktree** (the engine's `cwd`),
- a per-job **Docker sandbox** container,
- a continuous **brain session** (`job_sandboxes.session_id`).

The lifecycle is `JobLifecycleService` (`driver/job-lifecycle.service.ts`: `createJob` / `closeJob`,
`provisionSandbox`, branch cut). 🟡 **Provisioning is lazy, not eager** — the create/seed paths insert bare
rows, and the job brain **provisions on the job's first turn** (`ensureProvisioned`), so a job gets its
branch + sandbox + session the moment you talk to it (see §8).

## 4. The two session kinds — the heart of the model

There are **two completely different kinds of Claude Code session**. Conflating them is the #1 source of
wrong mental models. The **job brain** is the job's one main, continuous session — the thing you converse
with. The **build sessions** are what the *driver* runs to build the approved plan; you don't converse with
them (you observe them, and can interject the current build turn).

| | **Job brain** | **Build session (per thread)** |
|---|---|---|
| Count | **One** per job, *continuous* | **One orchestrator session per thread**, fresh & ephemeral |
| Session state | resumes `job_sandboxes.session_id` **every turn** | `steps.session_id` (batch anchor); resumed **only** on a mid-turn halt |
| Role | intent → grill → lock decisions → propose plan → **steer** | build **one thread** of the approved plan |
| System prompt | **custom plan mode** (NOT the SDK's native `ExitPlanMode`) | orchestrator prompt (Opus) that fans out to writer subagents |
| You talk to it via | the job **Conversation** (`say`) | the build **transcript** (*interject* the current turn) |
| Code | `brain/agent-session-manager.service.ts` (`handleChatTurn`) | `driver/thread-driver.service.ts` (`runThread`) |

**Job brain — the host tools** (`agent-session-manager.service.ts` `buildTools`). ~15 tools, grouped:
- *read/plan:* `get_pipeline_state`, `get_decision_record`, `submit_plan`, `finalize_plan`, `dispatch_build`
- *decisions/questions:* `create_decision`, `ask_question`, `answer`, `promote_decisions`
- *memory:* `recall`, `remember`
- *spin-off / intake:* `create_job` (a NEW independent job on this repo — own base branch, starts scoping),
  `create_ticket` (a note for LATER, no work starts), `request_secret` (onboarding)
- *fast path:* `start_direct_build` (a small localized change the brain implements itself, lightweight approval)

The brain is genuinely continuous: each turn resumes the same `session_id`, so it remembers the grilling,
the locked decision record, and the plan across turns and host restarts. `submit_plan` does NOT build — it
persists the plan (threads) + requests an async Codex review; `finalize_plan` posts the approval card; the
operator's approval is what dispatches the build.

**`create_job`.** ✅ The brain spins off a **new, independent** job on the same repo (`create_job({ title,
firstMessage })`) when work splits into its own unit. It inherits the base branch and starts scoping
immediately (`createFollowUpJob` → `startFollowUpJob`). Intentionally *independent* — an earlier
"blocked-until-merge" dependency variant was removed as too fragile.

**Build sessions.** After approval, each **thread** runs (default **ORCHESTRATE mode**) as ONE Opus
orchestrator session that decomposes the thread into a live **task list** (SDK `TaskCreate`/`TaskUpdate`) and
fans the implementation out to **writer subagents** (`implement` Sonnet / `implement-deep` Opus). They stream live to the
SSE surface (the build transcript / the navigator's task list + agents). `ORCHESTRATE_THREADS=off` falls back
to the legacy programmatic per-step batched path (one fresh session per step batch). A build session is *not*
the job brain — interjecting one steers that coding turn, not the job's intent.

## 5. The pipeline / driver — the hands  ✅

After a plan is approved, **`ThreadDriver`** (`driver/thread-driver.service.ts`) takes the wheel: a
deterministic, legible, **resumable** loop that walks the planned **threads** in order. Each thread runs
`orchestrate (or plan→execute steps) → review (autofix lenses over the thread diff) → auto-fix → handoff`;
threads stack on the **one** feature branch; **one PR per job**. It is a plain `await`-each-step loop, **not
an implicit FSM** — explicit `step`/`status` rows exist *only* so `resume()` can re-enter after a restart
(`resume()` re-drives `running` jobs; `resumePaused(jobId)` continues a paused one).

The brain and the driver run **concurrently**: you can keep talking to the job brain while the driver builds.
The brain has no tool to *alter* a running build (its tools are read/plan/dispatch), so live "steering"
beyond observing + interjecting the current build turn is 🟡 limited (see §6).

## 6. Inputs & steering surfaces

| Input | Route | Target | Status |
|---|---|---|---|
| Operator message | `POST …/jobs/:jobId/say` | job brain (`handleChatTurn`) | ✅ (provisions the sandbox lazily on first turn — §8) |
| Plan verdict | `POST …/jobs/:jobId/approve` | approval gate → dispatch on approve | ✅ |
| Answer a question card | `POST …/jobs/:jobId/answer-question` | brain (`answer`) | ✅ |
| Provide a secret | `POST …/jobs/:jobId/provide-secret` | encrypted store + grant (onboarding) | ✅ |
| Live observability | `GET …/repos/:repoId/events` (SSE) + `GET /web/jobs/realtime` | outbound stream (chat + cards + build events; cross-org "needs you") | ✅ |
| Automated event | `POST /ingress/github`, `/ingress/webhook` | event intake → **spawns a job** (§7) | ✅ |
| Retry / resume a halted build | `POST …/jobs/:jobId/retry` | `ThreadDriver.resumePaused` | ✅ |
| Interject the current build turn | build transcript composer (`say`) | folded in at the next turn boundary | 🟡 in-turn interject only |
| Pause / revert step / NL steering ("undo that step", "simplify the rest") | — | driver | ⛔ not built |

## 7. Event intake — the untrusted firehose

An automated event (CI failure, GitHub/PostHog/Sentry webhook) becomes a **job**. Four **mechanical guards**
run first — the firehose is hostile and noisy, and these have nothing to do with the job model, so they stay:

- **dedup + rate-limit**, no LLM — a Stripe re-delivery or a Sentry storm must not each pay a turn
  (`stimulus/event-filter.service.ts`).
- **repo routing** — a webhook carries no `org_id`, so `owner/repo` → connected repo
  (`stimulus/project-routing.service.ts`).
- **untrusted fence** — the body is DATA, never instructions (`stimulus/untrusted-content.ts`).
- **seed a job** + first message (stamped `meta.source='system_event'` → the operator-visible **EVENT
  bubble**) + stimulus row, with a DB unique-index dedupe backstop (`stimulus/stimulus-store.service.ts`).

**The model:** there is only **one brain per job — its session**. After the guards, an event is delivered to
the seeded job's brain as a **harness message** — a server-initiated turn (`AgentSessionManager.deliverEvent`
→ `handleChatTurn`, the same seam the Codex plan-review delivery uses). The brain reads a trusted framing
("an automated {source} notification opened this job — no human sent it…") wrapped around the
`wrapUntrusted`-fenced body, then triages it **in-session**. There is **no** `Stimulus` union, no
`StimulusRouter`, and no second event-only brain — those were deleted; the intake sink is the typed
`BRAIN_SINK` port (`handleChat` / `deliverEvent`).

- **Async + at-least-once.** Intake does NOT await the engine turn (the webhook 202 stays fast); it schedules
  `deliverEvent` and returns. Durability = `stimuli.delivered_at` (stamped only after the turn) + a leader
  boot sweep re-delivering any seeded event still `null`.
- **Security = the approval card.** **Every** event-spawned plan goes through the same human approval gate —
  no autonomous self-approve/dispatch lane. Untrusted → the brain proposes → a human approves → the harness builds.

## 8. Known divergences & tech debt

- **Provisioning** — ✅ closed on the brain path: `handleChatTurn` lazily provisions branch + sandbox +
  session via `lifecycle.ensureProvisioned` before the first turn (posting *"Setting up an isolated
  workspace…"*). **Still open:** an **event-seeded** job that reaches the driver *without* ever taking a brain
  turn skips lazy provision — `ensureSandbox` then takes the legacy fallback branch name.
- **Operator steering** — only in-turn interject + retry/resume are built; pause / revert-step / NL steering
  are ⛔ not built.
- **Build transcript diff / logs** — partly placeholder/derived in the web app (`web/BACKEND_GAPS.md`).
- **Docs** — `ATLAS_V2.md` still uses the OLD vocabulary (thread=container, track/section=lane, phase=step)
  and predates the redesign; treat it as history, not truth.

## 9. Durability — how a halt resumes  ✅

The contract: a halt **continues the same engine session**, it doesn't spawn a fresh one. The key fix is
persisting `session_id` at turn **start** (the first NDJSON frame), not just at success — so a mid-turn crash
still leaves a resume handle. Boot `ThreadDriver.resume()` re-drives `running` jobs; a per-job sandbox cold
re-attach prepends a `SANDBOX_RESET_NOTICE` so the resumed session re-establishes runtime it can no longer
trust; the job + branch survive a restart via the shared `.git`. A 401 mid-turn → `paused` (durable) → fix
creds → ping (`…/retry`) → the same session continues. (✅ for any job on the provisioned path — see §8.)
