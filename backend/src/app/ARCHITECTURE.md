# Atlas — architecture & the job/session model

> **Canonical, read-first.** This is the source of truth for how Atlas is _modelled_. Companions:
> `../../../CLAUDE.md` (product model + conventions), `ATLAS_V2.md` (deep detail + build history — but it
> predates the org→repo→job rebuild AND uses the old vocabulary; trust THIS file for the model),
> `../../../web/BACKEND_GAPS.md` (web API gaps), `../../../docs/adr/0008-first-class-thread-groups.md` (why the
> thread group/thread model below replaced the old jobs/threads/steps shape).
>
> All code paths below are relative to `backend/src/app/`.

**Vocabulary (post-rename — memorize this).** A **Job** is the CONTAINER (the unit of work: request → PR;
owns the branch, sandbox, PR, and one message log). A **Thread group** is the first-class §N PIPELINE-GROUPING unit
inside a job — `planning | plan_review | build | direct_build | master_review | post_build | ci`. A **Thread**
is a session-bearing lane with a `role` (`planning | plan_review | builder | review_agent | review_fix |
master_review | post_build | ci`), belonging to exactly one thread group. **Messages** are the thread-scoped log —
a job's conversation is the union of its threads' messages. DB: `jobs` / `thread_groups` / `threads` / `tasks` /
`subagents` (+ `job_sandboxes`). "Step" is RETIRED — the `steps` table (and the words "track"/"phase" for it)
is gone; a thread's engine-session identity now lives directly on the thread row. NOTE: "session" below
always means a **Claude Code / Agent-SDK session**, never a domain object.

**Status legend:** ✅ Built (matches code today) · 🟡 Partial / diverges from intent · ⛔ Planned (not built).
Where intent ≠ wiring, both are stated — this doc describes reality, not the aspiration.

---

## 1. The model in one paragraph

Atlas turns a **request** — a human message _or_ an automated event — into a reviewed **PR**. The unit of
work is a **job**. A job is its own git branch, its own sandbox, and its own _continuous_ Claude Code
session — **the job brain**, now represented as the job's `planning` thread group thread — which scopes, grills,
locks decisions, proposes a plan, and steers. Once the plan is approved, a deterministic **driver** ("the
harness takes the wheel") walks the plan's **thread groups** (each an ordinal-ordered §N grouping of one or more
threads) in order, and you watch the build stream live. **There is no central "Atlas" persona.** "Atlas"
_is_ the job brain, and the job brain _is_ the **main Claude Code session running inside that job's sandbox**
— when you open a job and type, you talk directly to that session (its system prompt opens with _"You are
Atlas"_ — `brain/agent-session-manager.service.ts:56`). Everything else — the driver, the intake guards, the
web surface — is host-side plumbing wrapped around that session and the later thread group threads (`post_build`,
`ci`) that take over its tail-end duties. An automated event doesn't talk to a central brain either; it
**spawns a new job** and becomes that job brain's opening (harness) message.

## 2. Product model — Organization → Repos → Jobs → Thread groups → Threads ✅

> **Deployment model: private, not SaaS.** Atlas is a personal/private tool for Dennis and a small circle of
> close friends — **not** a commercial multi-tenant SaaS. The org/sandbox isolation below keeps friends'
> work separate (and is defence-in-depth), not a boundary for untrusted paying customers. Read
> "tenant"/"multi-tenant" as _private multi-workspace_. See `saas-credential-compliance` for why selling was
> ruled out (subscription credentials can't back a sold product; API keys too costly to resell).

The hierarchy (detail in `CLAUDE.md`):

- **Organization** (`organizations`) — the tenant; `org_id` scopes every `app` table.
- **Repo** (`repos`) — a connected GitHub repo; the conversation container (the old 1:1 `channels` is gone).
- **Job** (`jobs`, real uuid) — a conversation/work unit on a repo; `messages` is its durable log (now
  partitioned by `thread_id` — a job's log is the union of its threads' messages, `job_id` stays denormalized
  for job-wide queries).
- **Thread group** (`thread_groups`, real uuid) — the first-class §N pipeline grouping (`thread-group.entity.ts`). A job's
  pipeline is the ordinal-ordered, APPEND-ONLY sequence of its thread groups:
  `planning → plan_review → build×N → master_review → post_build → ci`; a big post-build amendment
  APPENDS a fresh `planning(2) → plan_review(2) → …` round rather than replacing the prior thread groups, which
  stay as visible history. `kind` is a closed, code-validated vocabulary (not a DB enum) declared in
  `thread-group-kind/registry.ts`'s `THREAD_GROUP_KIND_SPECS`. `title` is nullable, populated only for `build`/
  `direct_build` (the slice name, e.g. "Foundation") and `planning` (to disambiguate re-plan rounds, e.g.
  "Re-plan #2"); other kinds derive their label from `kind` alone. `type` (the review-routing key —
  `backend | frontend | docs | testing | infra | data | general`) lives here too, moved off threads.
- **Thread** (`threads`, real uuid) — a session-bearing lane, differentiated by `role`
  (`planning | plan_review | builder | review_agent | review_fix | master_review | post_build | ci`,
  `thread-kind/registry.ts`'s `THREAD_KIND_SPECS`), related by `parent_thread_id` (a `builder` is the parent
  of its `review_agent`/`review_fix` siblings). **Every thread belongs to exactly one thread group**
  (`threads.thread_group_id` NOT NULL) — there is no job-level ungrouped thread, so even a pure-chat job has exactly
  one `planning` thread group from the start. A `build`/`direct_build` thread group owns MULTIPLE threads: one or more
  sequential `builder` threads (see §4 — this is what "legs" used to mean) plus its `review_agent`/
  `review_fix` children; every other thread group kind is a singleton (exactly one thread).

A **job is the build unit** — the former separate `jobs`-vs-`threads` split was collapsed into one container
(`brain/job-dispatcher.ts`). The build sub-structure now lives in `thread_groups` (was the UI-derived, ungrouped
notion of a "build lane") + `threads` (was `tracks`/`kind`, now `role`) + thread-group-owned `tasks` (was
`threads.tasks`/`jobs.main_tasks` jsonb) + `subagents` (a normalized replacement for the old ad-hoc
`meta.parentToolUseId ↔ meta.id` message-meta pointer pair). Kind-specific BEHAVIOR lives in the two
registries above, not in per-kind tables — adding a thread group/thread kind is one registry entry, never a new
table+entity+repository+joins. Kind-specific PARAMS live in a `config jsonb` column (`thread_groups.config`,
`threads.config`); a field is promoted to a real typed column only when it must be queried/indexed/FK'd
(e.g. `threads.session_id`/`commit_sha` for resume, `thread_groups.type` for review-agent selection).

## 3. The job = a branch + a sandbox + a session

Every job owns —

- a git **branch** `atlas/*` (stored on `jobs.feature_branch`), cut from a base branch,
- a durable **worktree** (the engine's `cwd`),
- a per-job **Docker sandbox** container,
- a continuous **brain session** (`job_sandboxes.session_id`, resumed by the job's `planning` thread group thread).

The lifecycle is `JobLifecycleService` (`driver/job-lifecycle.service.ts`: `createJob` / `closeJob`,
`provisionSandbox`, branch cut). 🟡 **Provisioning is lazy, not eager** — the create/seed paths insert bare
rows, and the job brain **provisions on the job's first turn** (`ensureProvisioned`), so a job gets its
branch + sandbox + session the moment you talk to it (see §8).

## 4. The two session kinds — the heart of the model

There are **two completely different kinds of Claude Code session**. Conflating them is the #1 source of
wrong mental models. The **job brain** — now the job's `planning` thread group thread — is the job's one main,
continuous session, the thing you converse with. The **build sessions** are what the _driver_ runs to build
the approved plan, one per `builder` thread; you don't converse with them (you observe them, and can steer
the current build turn via per-thread operator chat — see §6).

|                    | **Job brain (`planning` thread group thread)**                     | **Build session (per `builder` thread)**                                                             |
| ------------------ | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Count              | **One** per job, _continuous_                               | **One orchestrator session per builder thread**, fresh & ephemeral                                   |
| Session state      | resumes `job_sandboxes.session_id` **every turn**           | `threads.session_id` (relocated off the retired `steps` table) — resumed **only** on a mid-turn halt |
| Role               | intent → grill → lock decisions → propose plan → **steer**  | build **one builder leg** of a build/direct_build thread group                                              |
| System prompt      | **custom plan mode** (NOT the SDK's native `ExitPlanMode`)  | orchestrator prompt (Opus) that fans out to writer subagents                                         |
| You talk to it via | the job **Conversation** (`say`)                            | the build **transcript** (per-thread operator chat, §6)                                              |
| Code               | `brain/agent-session-manager.service.ts` (`handleChatTurn`) | `driver/thread-driver.service.ts` (`driveBuildThreadGroup`)                                                |

**Job brain — the host tools** (`agent-session-manager.service.ts` `buildTools`). ~15 tools, grouped:

- _read/plan:_ `get_pipeline_state`, `get_decision_record`, `submit_plan`, `finalize_plan`, `dispatch_build`
- _decisions/questions:_ `create_decision`, `ask_question`, `answer`
- _memory:_ `recall`, `remember`
- _spin-off / intake:_ `create_job` (a NEW independent job on this repo — own base branch, starts scoping),
  `request_secret` (onboarding)
- _fast path:_ `start_direct_build` (a small localized change routed through the `direct_build` thread group kind —
  see below — with lightweight approval)

The brain is genuinely continuous: each turn resumes the same `session_id`, so it remembers the grilling,
the locked decision record, and the plan across turns and host restarts. `submit_plan` does NOT build — it
persists the plan (thread groups + their threads) + requests an async Codex review (the `plan_review` thread group);
`finalize_plan` posts the approval card; the operator's approval is what dispatches the build.

**`atlas-prod` — prod diagnostics + gated recovery writes (Atlas repo only).** ✅ A conditionally-registered
host-bridge MCP (`app/prod-mcp/`), wired in ONLY when the repo slug === `ATLAS_REPO_SLUG` (`isAtlasRepo`) —
fail-closed, so no non-Atlas job ever sees it. It serves the 7 read-only `atlas_*` diagnostics tools on a
dedicated **SELECT-only** DB role (`mcp_reader`, its own DataSource — never the backend's `app` connection),
plus a **structurally-gated** write tool `propose_prod_write`: the brain can only _propose_ one single SQL
statement; it is previewed (an `EXPLAIN` planner estimate on the read-only role — the `mcp_writer` credential
is never touched pre-approval) and posted as an operator **approval card**. Only on approval does a _separate_
code path execute the exact approved statement on a **DML-only** role (`mcp_writer`, INSERT/UPDATE/DELETE, no
DDL) and write a durable audit row (`prod_maintenance_write`, which the writer role cannot itself mutate). The
agent holds only _propose_ — the recorded approval is what executes — so a confused/looping agent physically
cannot mutate prod. This is the same human-approval-gate shape as the plan/ship gates above, applied to prod
recovery.

**`create_job`.** ✅ The brain spins off a **new, independent** job on the same repo (`create_job({ title,
firstMessage })`) when work splits into its own unit. It inherits the base branch and starts scoping
immediately (`createFollowUpJob` → `startFollowUpJob`). Intentionally _independent_ — an earlier
"blocked-until-merge" dependency variant was removed as too fragile.

**Build sessions.** After approval, each **builder thread** runs (default **ORCHESTRATE mode**) as ONE Opus
orchestrator session that decomposes its thread group into a live, **thread-group-owned task list** (SDK
`TaskCreate`/`TaskUpdate`, persisted to the `tasks` table keyed by `thread_group_id` rather than a per-thread jsonb
blob) and fans the implementation out to **writer subagents** (`implement` Sonnet / `implement-deep` Opus,
each recorded as a `subagents` row). They stream live to the SSE surface (the build transcript / the
navigator's task list + agents). A build session is _not_ the job brain — steering one via operator chat
steers that coding turn, not the job's intent.

**Legs are gone as a concept — a "leg" IS a builder thread.** A `build`/`direct_build` thread group starts with
builder thread #1; when it crosses the context-pressure window, it authors a handoff and the driver inserts
builder thread #2 (a plain new `threads` row, same `thread_group_id`, gap-numbered `ordinal`, chained via
`parent_thread_id`), which resumes the THREAD GROUP's shared task list — not a per-leg one. Rotation is sequential,
never parallel; there is no more `build_legs` table. A `build` thread group's `review_agent`(s) + `review_fix` run
ONCE at the end, over the thread group's cumulative `start_sha..commit_sha` diff (both columns live on the
triggering `builder` thread) — they belong to the THREAD GROUP (linked via `thread_group_id`), not to one builder leg,
though they also keep `parent_thread_id` pointing at that builder for tree display. `direct_build` is the
no-review fast path: a single builder thread, no `review_agent`, no `review_fix`, no `master_review` thread group —
it still flows through `post_build` + `ci` like every other pipeline; it is one more `THREAD_GROUP_KIND_SPECS` entry,
not a special code path.

**Two more live thread groups take over what Main used to do at the tail end.** `post_build` is the ship-review
GATE thread group — spawned right at the gate (`ThreadDriver.parkForShipReview` → `DriverStoreService`'s
`parkForShipReview`, which calls `ensurePostBuildThread` once the transitioning write commits, i.e. as soon
as build/direct_build thread groups + `master_review` complete and the job parks `awaiting_ship_review`), on its
own fresh session (`threads.session_id`, isolated from `job_sandboxes.session_id`). It summarizes the build,
proposes a preview, and owns the amend loop (`withdraw_ship` → `amending` → follow-up work →
`report_verification` re-park) — it does **not** open the PR. `ci` is the post-ship PR-lifecycle thread group —
spawned at Ship (`BuildShipService.ship()` → `ensureCiThread`, before `openPrAtShip`) and again idempotently
once the PR is recorded (`latchPr` → `ensureCiThread` post-`setPrReady`); it owns PR creation (`openPrAtShip`
now fires with the **`ci`** thread's id, not `post_build`'s), the authoritative base-branch reconcile at PR
creation, and post-ship CI/GitHub event handling, addressed via `stimuli.lane = thread:<ciThreadId>`. Each
thread group gets its OWN lean agent/system prompt (`Agent.PLANNING` / `Agent.POST_BUILD` / `Agent.CI`,
`prompt-kit/system/agent.ts`) and its own tool allowlist (`thread-kind/registry.ts`) — all three keep full
engineering capability (edit, verify-by-running, git, `gh`, subagents); only `PLANNING`'s grilling/plan/
ship-gate apparatus is stripped from the other two, which are seeded with an initial message instead of a
live planning transcript.

## 5. The pipeline / driver — the hands ✅

After a plan is approved, **`ThreadDriver`** (`driver/thread-driver.service.ts`) takes the wheel: a
deterministic, legible, **resumable** loop that walks the job's **thread groups** in ordinal order
(`threadGroupsForJob`), driving each one per its `thread-group-kind` spec (`threadGroupKindSpec`) instead of branching on kind
inline. Each executable thread group (one whose spec contains a driver-executable role — `build`/`direct_build`'s
`builder`, `master_review`'s `master_review`) runs `orchestrate → review (autofix lenses over the thread group's
cumulative diff) → auto-fix → handoff`; render-only thread groups (`planning`, `plan_review`, `post_build`, `ci`)
never enter this loop — their runtime is a Claude Code session driven by the brain, not the driver. Thread groups
stack on the **one** feature branch; **one PR per job**. It is a plain `await`-each-thread group loop, **not an
implicit FSM** — explicit `status`/`condition` rows on `threads` exist _only_ so `resume()` can re-enter
after a restart (`resume()` re-drives `running` jobs; `resumePaused(jobId)` continues a paused one).

**The driver is HEADLESS.** The old `BrainGateway` had five methods; three are gone —
`notifyThreadHalted`, `notifyThreadDone`, `wakeForProvisioningFailure` (`brain-gateway/brain-gateway.service.ts`
now exposes only `openPrAtShip` + `wakeUnblockedJob`) — along with the synchronous push-notify that used to
call straight back into the planning brain the moment a thread halted or finished. A halted/failed thread
just records its halt (`threads.halt_outcome`/`halt_waked_at`/`halt_fix_attempts`) and shows `halted` in the
UI; there is no more automatic bounce back to the brain to auto-fix. There IS still a durable, at-least-once
"owed-wake" mechanism for the cases that legitimately still need the brain to know something happened —
`halt_outcome`/`done_wake_owed`/`done_wake_reason` columns on `threads`, drained by a periodic sweep — but
that is durable state + a sweep, replacing a synchronous push-notify call, not "nothing happens on halt." The
direct replacement for "the brain auto-fixes a halt" is the **operator**: every thread supports thread-scoped
operator messages (per-role `operatorInput` toggle, `thread-kind/registry.ts`), and posting to a halted
thread folds the message into its orientation and re-drives it (`ThreadDriver.redriveThread`) instead of the
driver escalating on its own — see §6.

The brain and the driver run **concurrently**: you can keep talking to the job brain while the driver builds.
The brain has no tool to _alter_ a running build (its tools are read/plan/dispatch); live steering happens on
the thread itself via operator chat (§6).

## 6. Inputs & steering surfaces

| Input                                                                     | Route                                                                    | Target                                                                                                                                      | Status                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Operator message                                                          | `POST …/jobs/:jobId/say`                                                 | job brain (`handleChatTurn`, the `planning` thread group thread)                                                                                   | ✅ (provisions the sandbox lazily on first turn — §8)                                                                                                                                                                                                                 |
| Plan verdict                                                              | `POST …/jobs/:jobId/approve`                                             | approval gate → dispatch on approve                                                                                                         | ✅                                                                                                                                                                                                                                                                    |
| Answer a question card                                                    | `POST …/jobs/:jobId/answer-question`                                     | brain (`answer`)                                                                                                                            | ✅                                                                                                                                                                                                                                                                    |
| Provide a secret                                                          | `POST …/jobs/:jobId/provide-secret`                                      | encrypted store + grant (onboarding)                                                                                                        | ✅                                                                                                                                                                                                                                                                    |
| Live observability                                                        | `GET …/repos/:repoId/events` (SSE) + `GET /web/jobs/realtime`            | outbound stream (chat + cards + build events; cross-org "needs you")                                                                        | ✅                                                                                                                                                                                                                                                                    |
| Automated event                                                           | `POST /webhooks/github/events`                                           | event intake → **route to the owning job (its `ci` thread group thread once one exists, else planning), else drop** — route-only, never seeds (§7) | ✅                                                                                                                                                                                                                                                                    |
| Per-thread operator chat                                                  | `postToThread(lane, …)`, `lane = "thread:<id>"` (web `/say`-style route) | the addressed thread — steers a live turn, or (if halted) folds into the thread's orientation and re-drives it                              | ✅ uniform capability on every thread; per-role `operatorInput` toggle gates whether a role accepts it (ON by default for `builder`/`planning`, OFF for `review_agent`/`review_fix`/`master_review`/`plan_review`/`post_build`/`ci` — flippable in one registry line) |
| Retry / resume a halted build                                             | operator posts to the halted thread's lane (above)                       | `ThreadDriver.redriveThread`                                                                                                                | ✅ operator-initiated — no more brain-auto-fix loop (§5)                                                                                                                                                                                                              |
| Pause / revert step / NL steering ("undo that step", "simplify the rest") | —                                                                        | driver                                                                                                                                      | ⛔ not built                                                                                                                                                                                                                                                          |

## The Workspace Profile — the one provisioning area Atlas keeps current

Everything a repo needs to be a **runnable, correctly-configured workspace** is one named area: the
**Workspace Profile**. It has seven dimensions, each stored separately but conceived as one thing:

| Dimension            | Storage                                                 | Upkeep tool                                            |
| -------------------- | ------------------------------------------------------- | ------------------------------------------------------ |
| Secret files         | `org_workspace_secret_files`                            | `request_secret` / `request_file` / `derive_secret`    |
| Mounts               | `org_workspace_mounts`                                  | `write_workspace_config`                               |
| Cache folders        | mounts (`shared-rw`) + fixed durable HOME binds         | `write_workspace_config`                               |
| Setup / SDK installs | `repos.setup_script`                                    | `write_setup_script`                                   |
| MCP servers          | `mcp_servers`                                           | `propose_mcp_servers` (owner-approved)                 |
| Skills               | `workspace_skills`                                      | `propose_skill` (owner-approved reusable `SKILL.md`)   |
| House style          | `convention_profiles` + `repos.convention_profile_slug` | `propose_convention_profile[_change]` (owner-approved) |

The tables stay separate; the unification is at four seams:

- **Read-model** — `WorkspaceProfileService` (`workspace-profile/`) composes the seven per-dimension stores
  into one snapshot (`describe` → `render`). No storage of its own; never exposes a secret _value_. It also
  derives host-visible **gaps** (`computeGaps` → `renderGaps`) the brain can't see from the snapshot — v1:
  an approved MCP server with an unfilled secret slot (it silently fails auth). Rendered only when present.
- **Bridge** — every dimension's upkeep tool lives on a dedicated `workspace-profile` MCP bridge
  (`sandbox/image/workspace-profile-bridge-options.ts`), so the brain addresses them as
  `mcp__workspace-profile__*` — one coherent section, distinct from the general `atlas-host-bridge`.
- **Prompt** — the snapshot (+ any gaps) is injected into the brain every turn (`ctx.settings.workspaceProfile`)
  by the single `workspace-profile.group` (was `environment.group`), which names the area, prints the current
  state, and lists each dimension's upkeep tool.
- **Lifecycle** — **onboarding is the first BULK pass** over the profile (`isOnboarding` fragments +
  `finish_onboarding`); **every job after keeps it current INCREMENTALLY** — the same upkeep tools live in
  the shared `intake` bundle so any build fixes a gap it hits (a missing secret, a new cache, a skill worth
  adding) so the _next_ job inherits it. Same area, same tools, different framing.

The onboarding bulk pass also makes each **user-facing surface** live-accessible in a browser through the
preview proxy — it exposes the surface (`atlas-svc run --port <n> --expose`, opt-in, + Caddy reconcile a deterministic
`https://$ATLAS_PREVIEW_ID-<svc>.$ATLAS_PREVIEW_DOMAIN` route), probes it end-to-end AS A BROWSER with the
baked `atlas-probe` helper (headless Playwright/chromium; classifies dns / bind_ip / port / dev_origin / cors
/ api_base_url / cookie / blank blockers), and remediates env-first (persisting the resolved preview origins +
cookie/CORS config into the setup-script + secret-file dimensions above; a minimal PR only when repo code must
READ that env). `finish_onboarding`'s green-gate requires that live preview-accessibility evidence, so future
jobs inherit a browser-reachable stack with no re-derivation. See
`docs/adr/0007-live-service-accessibility-onboarding.md`.

Skills load in-container via the SDK `plugins: [{type:'local', path}]` option (rendered to a host-owned
`SKILL.md` dir per turn from `RunEngineArgs.skills`), independent of `settingSources: []` — so full
filesystem-settings isolation is preserved while exactly the resolved skills are enabled.

## 7. Event intake — the untrusted firehose

An automated event that becomes or advances work (a CI failure, a review, a PR/issue comment) is **routed to
the job that already owns its PR/branch — or, when nothing owns it, dropped** (ROUTE-ONLY, decision **d6**;
`stimulus/stimulus-intake.service.ts`). Correlation-first: an event carrying a PR# or branch an existing job
owns is delivered to THAT job's brain (`resolveOwningJob`); an event nothing owns (external / default-branch
CI) is a deliberate no-op. Repo activity **NEVER silently seeds a job** — deliberate job creation stays with
the operator / an explicitly configured integration. Routing produces a brain **stimulus / harness
notification** for the owning job; it NEVER writes the job's DB sync columns (`pr_state` / `pr_url` /
`status`) — that is the separate silent PR-state path (below). Three **mechanical guards** run first — the
firehose is hostile and noisy, and these have nothing to do with the job model, so they stay:

- **dedup + rate-limit**, no LLM — a Stripe re-delivery or a Sentry storm must not each pay a turn
  (`stimulus/event-filter.service.ts`).
- **repo routing** — a webhook carries no `org_id`, so `owner/repo` → connected repo
  (`stimulus/project-routing.service.ts`).
- **untrusted fence** — the body is DATA, never instructions (`stimulus/untrusted-content.ts`).

Then **route or drop** (decision **d6**): when a PR#/branch correlation matches a live job, attach the event
to it (message stamped `meta.source='system_event'` → the operator-visible **EVENT bubble** + stimulus row,
with a DB unique-index dedupe backstop; `stimulus/stimulus-store.service.ts`) and deliver it to that job's
brain. No match → drop (a 202 `ignored`). There is no seed-a-new-job path — that was removed with the generic
`/ingress/webhook` endpoint. **Once the job has shipped a PR and its `ci` thread group thread exists** (§4), a
post-ship event's `messages` row and `stimuli.lane` both target that thread (`thread:<ciThreadId>`) instead
of planning, so it resumes the `ci` thread's own isolated session; pre-ship (no `ci` thread yet) it still
falls back to planning exactly as before.

**The model:** an intake event goes straight to the owning **thread's** brain — its OWN Claude Code session
(planning by default, `ci` once one exists per the paragraph above). After the guards, an event is delivered
as a **harness message** — a server-initiated turn (`AgentSessionManager.deliverEvent` → `handleChatTurn`,
the same seam the Codex plan-review delivery uses). The brain reads a trusted framing ("an automated {source}
notification about this job — no human sent it…") wrapped around the `wrapUntrusted`-fenced body, then
triages it **in-session**. There is **no** unified `Stimulus` union, no `StimulusRouter`, and no second
event-only brain — those were deleted; the intake sink is the typed `BRAIN_SINK` port (`handleChat` /
`deliverEvent`), and each inbound request reaches the system as one of two in-memory shapes,
`ChatStimulus` (duplex, continues a thread) or `EventStimulus` (inbound-only, seeds or attaches to a thread) —
kept deliberately separate from any unifying discriminated type (`domain/stimulus.ts`).

- **Async + at-least-once.** Intake does NOT await the engine turn (the webhook 202 stays fast); it schedules
  `deliverEvent` and returns. Durability = `stimuli.delivered_at` (stamped only after the turn) + a leader
  boot sweep re-delivering any attached event still `null`.
- **Security = the approval card.** **Every** plan goes through the same human approval gate —
  no autonomous self-approve/dispatch lane. Untrusted → the brain proposes → a human approves → the harness builds.
  The one sanctioned exception is a per-job **auto-approve** opt-in (`jobs.auto_approve_mode` —
  `off | plan | ship | both`): when the mode covers a gate, that job's plan and/or ship-review gate —
  including gates an EVENT drives it back into — auto-advances the instant the card posts, with no human click. It is acceptable only because it is either an explicit, per-job operator opt-in, or an
  org-level default (`organizations.default_auto_approve_mode` / `default_auto_merge`) an owner
  deliberately set — seeded into the job at creation (an explicit create-job request value still wins),
  and still overridable per job afterward — on this private/trusted deployment.

### GitHub → Atlas sync — two front doors + a layered model

GitHub deliveries split by **what the event is for**, not just where they land — and PR-state sync is
**layered / defense-in-depth**, so no single missed signal strands a job in the wrong state. Two axes stay
distinct throughout: **`pr_state`** (the PR lifecycle — `open | merged | closed`, drives the sidebar glyph)
is SEPARATE from **`status`** (the build lifecycle, which latches `done` the moment a PR opens and can't tell
open-vs-merged) — a merge flips `pr_state` only (`persistence/entities/job.entity.ts` `pr_state` :204-214).
Never conflate them.

**Two front doors** (they carry different kinds of GitHub payload):

Both are literally GitHub webhooks on the same repo, auto-registered per repo (`onboarding` `ensureRepoWebhook`)
and split by event set + downstream behavior — named by behavior so the purpose is apparent at the URL:

- **`/webhooks/github/events` — WORK-EVENTS → route to the owning job.** Events that advance work — CI
  (`workflow_run` / `check_run` / `check_suite`), `pull_request_review`, review / issue comments (`WORK_EVENTS`,
  `git/github-pr.service.ts`) — run through `StimulusIntake.intakeEvent`, which ROUTES to the job that owns the
  event's PR/branch and DROPS anything unowned (route-only, **d6** — §7 above). This wakes the owning job's brain.
- **`/webhooks/github/state` — pure state facts (silent).** Carries two `STATE_EVENTS`:
  - A `pull_request` event (opened / closed / merged / reopened) is a _fact_ about a PR, not a task:
    `GithubNotificationSource` classifies it as a `pr-sync` delta (`ingress/ingress-http.ts` `runPrWebhook`)
    applied by `GithubPrStateSync` → `JobLifecycleService.applyGithubPrState` (`driver/job-lifecycle.service.ts`),
    which writes the sync columns DIRECTLY — `pr_state`; plus `pr_url` / `pr_number` / `status:'done'` when the
    branch is owned by a job (opened); sandbox teardown on close/merge; `pr_state` back to `open` on reopen.
  - A `push` to the repo's **DEFAULT branch** is the real-time base-move-conflict unlock: `GithubNotificationSource`
    emits a `repo-push` outcome → `GitStateReconciler.markRepoDue` stamps every OPEN PR on that repo `next_poll_at =
now()`, so the fast heartbeat re-checks mergeability within seconds. This catches a base-induced conflict —
    the one PR-state change GitHub emits **no** webhook for (a moved base silently makes an open PR `dirty`).
    Non-default-branch pushes are ignored (a feature head moving is the PR's own commit — the ~45s cadence has it).

  This door NEVER touches `StimulusIntake` — a state fact must not wake the brain or seed a job (decision **d2**),
  and its hook is distinct from the work-events hook (decision **d5**).

> The generic first-party `/ingress/webhook` endpoint (PostHog/Sentry/cron template) was **removed** — it was
> wired but never registered/used, and could only seed. Re-add cleanly when a real integration needs it.

**The layers** (fastest first; each is a fallback for the one above):

1. **Fast path — webhooks.** The two front doors deliver in near-real-time.
2. **Direct-build turn-end latch.** When a `finalize_build` (direct-build) brain turn opens the PR, a turn-end
   hook immediately runs the existing branch-discovery latch (`BuildShipService.latchPr` → `setPrReady`) to
   record `pr_url` / `pr_number` and flip `status` `running → done` — instead of waiting on the poll
   (decision **d3**). Fire-and-forget, to avoid a per-job turn-queue deadlock. Full-path
   `dispatch_build` behavior is unchanged. There is **no** brain-reported-PR-URL tool (decision **d1**);
   host-side branch discovery (`findOpenPullByHead`) stays the mechanism by which Atlas learns of an opened PR.
3. **Adaptive near-real-time poll — `GitStateReconciler.tick`.** The reconciler's flagship job is the ONE
   PR-state signal no webhook emits: a **base-move merge conflict** (`mergeable_state → dirty`). It runs on a
   fast **~15s leader heartbeat** (`driver.module.ts` `startPollTimer`), but reconciles only jobs whose durable
   `jobs.next_poll_at` clock is DUE, then re-stamps that clock by an **adaptive cadence** (`CADENCE_MS`): ~8s
   while GitHub is still computing mergeability (the conflict window), ~45s for a settled open PR, ~3min for a
   branch still building with no PR yet, and CLEARED once the PR is merged / closed / gone (teardown owns it).
   The clock is DB-durable (not an in-memory timer) so it survives the constant prod restarts that starved the
   old fixed 30-min sweep AND survives leader failover; a default-branch push (`markRepoDue`, layer above) marks
   the repo's open PRs due-now with one `UPDATE`. Conflict routing goes through `StimulusIntake.intakeEvent`
   (route-only) to the owning job's brain, deduped per conflicting head SHA.
4. **Backstop — the 30-min reap timer.** `pollPrClosures` (merge/close teardown — already real-time via the
   state webhook) + idle-sandbox reap + the stranded-job re-drive stay on the slow 30-min timer. The webhook
   fast path and `pollPrClosures` call the SAME `applyGithubPrState`, so they can't drift.
5. **Delivery — per-repo auto-registration.** Atlas auto-registers the hooks per repo on connect / revalidate
   (+ a one-time boot backfill for `access_ok` repos), idempotently, always re-PATCHing the secret (GitHub
   hides the stored one, so drift is undetectable). Registration is **SKIPPED** when `BACKEND_HOST` is
   unset / localhost / non-public-https (Atlas running locally — GitHub can't deliver there; debug-log, no
   warning), and degrades gracefully (a checklist warning) when the PAT lacks `admin:repo_hook`. Per-repo (not
   org-level) because the PAT spans several GitHub orgs with no 1:1 Atlas→org mapping. Webhooks are a
   best-effort accelerator — the adaptive poll (layer 3) is always the backstop, never bypassed.

## 8. Known divergences & tech debt

- **Provisioning** — ✅ closed on the brain path: `handleChatTurn` lazily provisions branch + sandbox +
  session via `lifecycle.ensureProvisioned` before the first turn (posting _"Setting up an isolated
  workspace…"_). **Still open:** an **event-seeded** job that reaches the driver _without_ ever taking a brain
  turn skips lazy provision — `ensureSandbox` then takes the legacy fallback branch name.
- **Operator steering** — per-thread operator chat + retry/resume via re-drive are built (§6); pause /
  revert-thread-group / NL steering are ⛔ not built.
- **Build transcript diff / logs** — partly placeholder/derived in the web app (`web/BACKEND_GAPS.md`).
- **Per-thread group prompting** — `post_build`/`ci` currently reuse the planning brain's system prompting verbatim
  (§4); dedicated per-thread-group system/JIT prompting is deferred to a follow-up job — treat the current split as
  orchestration-only, not yet content-tuned per thread group.
- **Docs** — `ATLAS_V2.md` still uses the OLD vocabulary (thread=container, track/section=lane, phase=step)
  and predates the redesign; treat it as history, not truth. `docs/adr/0008-first-class-thread-groups.md` is the
  decision record for the thread group/thread model this file now describes.

## 9. Durability — how a halt resumes ✅

The contract: a halt **continues the same engine session**, it doesn't spawn a fresh one. The key fix is
persisting `threads.session_id` at turn **start** (the first NDJSON frame), not just at success — relocated
off the retired `steps` table (d5) — so a mid-turn crash still leaves a resume handle. Boot
`ThreadDriver.resume()` re-drives `running` jobs; a per-job sandbox cold re-attach prepends a
`SANDBOX_RESET_NOTICE` so the resumed session re-establishes runtime it can no longer trust; the job + branch
survive a restart via the shared `.git`. A 401 mid-turn → `paused` (durable) → fix creds → ping (`…/retry`) →
the same session continues. (✅ for any job on the provisioned path — see §8.)

A halted **build** thread does not auto-resume: the driver is headless (§5), so it just records the halt
(`halt_outcome`, surfaced as `halted` in the UI) and waits. Resuming it is an explicit operator action —
posting to the thread's lane folds the operator's guidance into its orientation and calls
`ThreadDriver.redriveThread`, which re-enters the resumable drive loop above under the same budget/dedup
machinery (`halt_fix_attempts`, `halt_waked_at`) that used to serve the autonomous brain-wake path.
