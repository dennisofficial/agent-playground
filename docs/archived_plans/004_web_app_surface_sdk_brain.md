# Atlas v2.1 — web-app surface + SDK-as-brain, multi-tenant-isolated

> Codex review folded in (two rounds). R1: keep two-level planning (no pre-locked phases), pre-review the persisted decision-record+section source, sandbox lifecycle precedes the brain, the tool bridge is a real streaming-transport rewrite, delete host-side `ScopingInvestigatorService`. R2: there is no chat-only consumer (add a `StimulusRouter` splitting chat/event), thread-creation is its own control path (not just a surface adapter), the host-git exception needs a hooks/filters-disabled policy, and R1's gate must prove the live streaming contract + cross-thread scope denial. SDK premise confirmed (`@anthropic-ai/claude-agent-sdk@0.3.168` exposes `createSdkMcpServer`/`mcpServers`).

## Context

Atlas v2 works (deterministic section/phase driver, docker sandboxes, memory, gates, durability — all proven on `main`). Through this session's design we converged on a different *front half*:

- **Drop Slack as the interface → a custom web app.** `CHAT_SURFACE` is already a DI port; web is a new adapter.
- **Delete the custom conversational brain** (the structured grill LLM: `triage`-chat / `conversational-brain` / `brain-llm` grill). Each thread becomes a **Claude Agent SDK session** the operator talks to directly; the harness exposes its operations to that session as tools. The deterministic driver still owns the build — the LLM observes and proposes, it never sequences (the v2 thesis).
- **Multi-tenancy is load-bearing and SaaS-shaped (build-for-SaaS, not release-as-SaaS yet):** the host runs **no tenant agent turns and no tenant-controlled code** — not even read-only planning; each thread's **sandbox IS the tenant's environment**. The conversational session runs *inside the thread's sandbox*; harness tools are invoked from the sandbox but executed host-side. **Git/PR is the one deliberate host-side exception** (so the token never enters the sandbox) — see the host-git policy below; it is harness plumbing, not tenant code execution.

Scope decisions locked with the user: **evolve in place** (reuse the v2 substrate; rewrite only brain + surface; extend the engine), **core spine first** (defer mid-build steering ops). Full converged model: memory `atlas-web-app-sdk-brain`.

---

## Locked decisions

- **Evolve in place.** Reuse: `driver/` section/phase **sequencing** (dispatch/resume/runJob/runSection/finishWithPr), `memory/`, `decision-gate/` classifier, `autofix/` (incl. PR-tail), persistence entities, durability/resume, `git/` PR client, `persistPlan`/decision-record persistence. (Driver sequencing reused; its **sandbox acquisition** and the `LocalGit` worktree API are adapted — see R2.)
- **Brain runs IN the sandbox.** A per-thread Claude Agent SDK session (`query()` with in-process `mcpServers`, `resume`) runs inside the thread's container. Replaces the v2 conversational brain.
- **Tool bridge = bidirectional frames over a NEW streaming engine transport.** Today's transport is one-shot (one JSON stdin payload → close stdin → consume stdout NDJSON; the entrypoint reads all stdin before running). The bridge requires a **new `ContainerEngine`/exec contract**: stdin stays open, the host writes live, both sides demux frames. The in-container entrypoint hosts a thin `createSdkMcpServer` whose tool handlers emit `{t:'tool_request',id,name,args}` and await `{t:'tool_response',id,result}`; the host answers each by calling the harness impl, **scoped to the thread that owns the exec**. No in-container daemon, no network endpoint. In `local` mode the same bridge runs over a child subprocess's stdio (harness process runs no tenant code; offline tests still run). SDK custom tools are doc-supported (code.claude.com/docs/en/agent-sdk/custom-tools); the work is the repo transport.
- **Tool surface (observe + submit + dispatch — core spine):** `get_pipeline_state`, `get_decision_record`, `recall`, `remember`, `submit_plan`, `dispatch_build`. The driver sequences the build. Steering ops (user-pause, interject, revert-phase, revise-plan, park-durability) DEFERRED.
- **Custom plan mode.** The planning session runs with our tools + a system prompt explaining them; the agent calls `submit_plan` instead of the SDK's native `ExitPlanMode`.
- **`submit_plan` stays high-level but detailed; two-level planning is KEPT.** It persists a thorough **decision record** (the locked architecture — the real seed context every section inherits) + **detailed section specs** (richer than today's one-line briefs; `atlas_sections.brief` is already free text). **Per-section JIT phase planning is RETAINED** (`SectionDriver.planSection` unchanged) — it expands each detailed brief into concrete phases against the real code at that point (stays <300k, grounds in prior sections' actual output). We do **not** pre-lock phases at approval, so `AtlasSection`/`AtlasPhase`/`BrainStoreService`/`planSection` contracts are unchanged.
- **Codex plan pre-review (one-shot, NEW).** On `submit_plan`, before the operator sees it: the host runs ONE Codex review turn **in the thread's sandbox**, relays findings into the Claude session for a single revision, then raises the approval card. It reviews the **persisted decision-record + section plan** (the same artifact the operator reviews and the source that gates + seeds every section) — NOT per-section phases. The existing **per-section review + always-ask gate inside `runSection()` is retained unchanged**: two complementary reviews at two levels.
- **Branch model.** At thread creation the operator picks a **base branch** (default = repo default). Planning reads it read-only. On **approval**, the spine cuts `atlas/<feature>` off the base **in the same sandbox checkout** → **one PR**.
- **One long-lived sandbox per thread.** Provisioned at thread creation on the base branch; persists through planning and build; branch-switch in-place on approval. Git/PR stay host-side (token never enters the sandbox); the tenant's own LLM key is injected for the agent's model calls.
- **Host-git policy (so the host-side exception can't run tenant code).** All host `LocalGitService` operations (clone/worktree/commit/checkout/push) run with **hooks and code-executing filters disabled** — `-c core.hooksPath=/dev/null`, no `clean`/`smudge`/`fsmonitor`, no per-repo config sourced from the tree — so a tenant repo's hooks can't execute on the host. This is the precise meaning of "host runs only the harness": git *plumbing* against tenant content is allowed; tenant-authored *code* never runs host-side.
- **Web surface** = new `CHAT_SURFACE` adapter (WS/SSE + REST); the Slack adapter is kept but dormant. Approval card + park-and-ask render as web payloads (adapt `approval-blocks`).
- **Final PR review + self-fix** = the existing PR-tail auto-fix, reused unchanged.
- **Event lane** unchanged in spirit: untrusted-notification triage stays a small headless classifier (the only place a gate remains); it dispatches to the same driver. Chat is never gated.

---

## Thread lifecycle (the spine)

1. **Create thread** (operator picks base branch) → provision the per-thread sandbox on the base branch → wait healthy.
2. **Converse** — the in-sandbox Claude session ⇄ operator over the web surface; tools via the bridge; custom plan mode; context injected at session start.
3. **`submit_plan`** — a detailed decision record + detailed section specs.
4. **Codex pre-review (one-shot)** — host runs a Codex review turn in the sandbox → findings fed back to the session → one revision.
5. **Approval card (web)** — approve / revise / deny. *Deny = keep talking* (re-opens scoping). *Approve* → spine takes over.
6. **Build** — driver `dispatch` → cut feature branch in the sandbox → walk sections/phases (each a fresh in-sandbox session, same container; per-section JIT plan → existing review/gate → execute → auto-fix) → web UI shows pipeline + per-phase transcript/diff.
7. **Finish** — PR-tail auto-fix → one PR.

---

## What changes, by area

- **Surface (`surface/`, new web ingress).** `AtlasWebSurface implements ChatSurface` over WS/SSE; REST for thread/transcript history; operator approve/deny clicks arrive here. Bind via `ATLAS_SURFACE=web`; Slack dormant. Likely add optional `update(channel, ts, …)` to the port for card edits. Adapt `approval-blocks.ts` → web card payload (keep domain shapes).
- **Engine + sandbox (`engine/`, `sandbox/`) — the heavy lift.** (a) New **streaming exec/`ContainerEngine` contract** + the `tool_request`/`tool_response` bridge (docker exec + local subprocess), host-side dispatch with per-thread scoping. (b) In-container thin `createSdkMcpServer` proxy. (c) **Conversational turn type** = an in-sandbox `query()` that resumes the thread's session and keeps the tool channel open during the turn; streams events to the host for the web UI. (d) **Per-thread sandbox + worktree-API redesign**: from per-feature-branch (attached at `SectionDriver.ensureSandbox()` build time, keyed `team·project·branch`) to **per-thread**, provisioned on the base branch at thread creation, branch-switched on approval, reused by build phases.
- **Intake split (`stimulus/`).** Today one `STIMULUS_CONSUMER` (→ `TriageService.consume`) routes both chat and events. Introduce a thin **`StimulusRouter`** bound as that single consumer: chat → `AgentSessionManager`, event → a retained **`EventTriageService`** (extracted verbatim from `triageEvent` — the untrusted-notification security/park/dispatch path). This is the seam that lets us delete the chat brain without touching the event lane.
- **Brain (`brain/` — REPLACE the conversational half).** New `AgentSessionManager` (the chat target of `StimulusRouter`) owns: per-thread session lifecycle, system prompt + tool declarations, and the **host-side tool impls** — `submit_plan` → reuse `brain-store.persistPlan`; `get_pipeline_state`/`get_decision_record` → `driver-store` reads; `recall`/`remember` → `AtlasMemoryStore`; `dispatch_build` → `JOB_DISPATCHER` (gated by approval). **Delete** `conversational-brain.service.ts`, the grill half of `brain-llm.ts`, the chat half of `triage.service.ts`, **and `scoping-investigator.service.ts` + the chat answer-question lane** (host-side read-only engine pass that bypasses `ENGINE_RUNNER`/`SANDBOX_PROVIDER` — violates the invariant; the in-sandbox session reads the repo itself). **Keep** the event path as `EventTriageService`.
- **Plan pre-review (`brain/plan-review.service.ts`, NEW).** On `submit_plan`: run a Codex review turn in the thread's sandbox (read-only), parse findings, relay into the session once, then raise the approval card.
- **Persistence.** Mostly reused. Add a thread↔sandbox association (container id + base/feature branch + lifecycle) for the per-thread sandbox model — labels-as-source-of-truth may not cover the planning-before-job phase. Decision-record/section schema unchanged.

**Reused as-is:** `decision-classifier`, `AutoFixStage` (incl. PR-tail), durability §9, `GithubPrService`, the decision-record/section persistence, the driver's section/phase sequencing + JIT `planSection` + per-section review/gate.

---

## Build decomposition (Opus sub-agents, dependency-ordered)

- **R0 — Web surface.** `AtlasWebSurface` + WS/SSE/REST ingress + composition; approval card as web payload; Slack dormant. *Gate:* a web/agent client posts and receives over the surface; an approval card renders and a click resolves it.
- **R1 — Tool bridge (GATING, heaviest).** New streaming `ContainerEngine`/exec contract (stdin stays open, host writes live, both sides demux frames) + `tool_request`/`tool_response` protocol over docker exec AND local subprocess; in-container thin MCP proxy; host-side dispatch with per-thread scoping. *Gate (must show the live contract, not just the parser):* a **thread-owned** sandbox runs an in-sandbox turn that calls `get_pipeline_state` over **live stdin**, the host returns a **correlated** response, the turn continues — and a tool request **scoped to another thread is denied**. No in-container daemon.
- **R2 — Thread lifecycle + per-thread sandbox/worktree API (prereq for the brain).** (a) An explicit **create-thread** control path — pick base branch, persist the `atlas_thread` + project/channel binding + a thread↔sandbox row — distinct from today's inbound-message-derived threads. (b) Redesign `SandboxManager`/`LocalGit` from per-feature-branch/build-time (`FeatureSandbox` attached at `ensureSandbox()`) to **per-thread**: provision on base at thread creation, branch-switch (cut feature) on approval, reuse for build phases, host git with hooks/filters disabled. *Gate:* a "new thread" call provisions a base-branch sandbox; the same sandbox later opens a PR on the feature branch.
- **R3 — Intake split + AgentSessionManager (the brain; depends on R1+R2).** Add `StimulusRouter` (chat→brain, event→extracted `EventTriageService`); build `AgentSessionManager` (per-thread session lifecycle, custom plan mode, the 6 tools wired to host impls); delete the v2 conversational brain + `ScopingInvestigatorService`. *Gate:* chat → grill → `submit_plan` persists a detailed decision record + sections (offline, fake-LLM ok); an event still parks/dispatches via `EventTriageService`.
- **R4 — Codex plan pre-review.** `PlanReviewService` one-shot on `submit_plan` → in-sandbox Codex turn → findings → one revision → approval card. *Gate:* a plan gets exactly one Codex pass + revision before the card.
- **R5 — Wire approval → build → PR.** Approval → `dispatch` → driver (sequencing reused) → in-sandbox build on the thread's sandbox → per-section JIT plan/review/gate/execute/auto-fix → PR-tail → PR; web UI shows pipeline/phases/transcripts. *Gate:* end-to-end feature drive through the web (or agent) surface opens a real PR.
- **R6 — Verification, flag, cleanup.** Env + flags; prune dead Slack-only paths kept dormant; tests.

---

## Verification

- **End-to-end:** create thread (pick base) → in-sandbox planning session ⇄ operator → `submit_plan` → Codex pre-review + one revision → approve → build → one PR. Drive via the agent surface in tests; manually via the web app.
- **Multi-tenancy invariant:** assert the host runs no tenant agent turns / arbitrary code — planning AND build turns execute in-sandbox (no `EngineRunner` injected outside `ENGINE_RUNNER`/`SANDBOX_PROVIDER`; `ScopingInvestigatorService` gone); the GitHub token never enters the sandbox; host git runs with hooks/filters disabled (a planted repo hook does not execute host-side); two concurrent threads = two isolated sandboxes on separate networks, and neither can invoke the other's tools.
- **Two-level planning intact:** `submit_plan` persists decision-record + section specs; per-section JIT `planSection` + the existing per-section review/gate still run at build time (regression).
- **Deny path:** deny returns to scoping; the next message continues the same session.
- **Regression:** the full existing atlas suite stays green (driver sequencing/memory/gate substrate untouched); `local` mode runs the brain over a subprocess so offline/CI tests don't need Docker.
- **Unit:** the tool-bridge frame protocol (request/response correlation, thread scoping, live stdin), `submit_plan` → decision-record shape, AgentSessionManager turn loop, plan-review one-shot.
- Typecheck + suite green after the brain deletion.

---

## Deferred (explicitly, per "core spine first")

Mid-build steering ops (user-initiated pause, interject-into-phase, revert-phase + per-phase start SHA, revise-plan + re-gate, park-and-ask durability) — the chat/buttons "second-guess mid-build" richness. The read+submit+dispatch core proves the spine first; these layer on after.