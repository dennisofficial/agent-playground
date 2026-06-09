# Planning Mode for the Worker — Technical Handoff

**Goal:** Let the worker (coding agent) *participate in planning* instead of only receiving a
finished spec. Before executing, the worker should be able to ask clarifying questions, surface
unknowns, and iterate with the chat-self (and through it, the human) — then execute once the plan
is settled.

This document answers the six exploration questions, then lays out options (minimal → richer), a
recommendation, and the exact files/functions to touch.

---

## 1. Current QUESTION / BLOCKED flow, end to end

The whole mechanism already exists for "worker needs human input." Planning mode is largely a
matter of *encouraging* and *shaping* this loop, not building new plumbing.

1. **Dispatch** — `dispatch_job` tool (`src/chat.ts:28`) calls `createJob(...)` (`src/jobs.ts:54`,
   status `running`, `turns: 0`) then fires `runWorkerTurn(job.id, task)` fire-and-forget inside a
   cleared AsyncLocalStorage store (so the worker's callbacks don't bleed into the chat stream).

2. **Run** — `runWorkerTurn` (`src/worker.ts:48`) calls `getEngine(job.engine).run({...})` with the
   task as `task`, `workerPromptFor(job.engine, bot)` as `systemPrompt`, and `job.sessionId`
   (undefined on first run). The engine loops *internally* to completion and returns
   `{ result, sessionId }`. Progress events stream into the per-job buffer via `onEvent`.

3. **Status detection** — `statusFromReport(report)` (`src/worker.ts:35`) inspects only the **last 5
   lines** of the report, matches the last `STATUS:` line, and maps:
   - `QUESTION` or `BLOCKED` → `'awaiting'`
   - `DONE` / `PROGRESS` / none → `'done'`

   `updateJob` then persists `status`, `sessionId`, `lastReport` (the full final text), and
   `turns: job.turns + 1`. On `done` it also writes the worklog.

4. **Relay to chat** — the conductor subscribes via `onJobUpdate` (`src/conductor.ts:86`). When a job
   becomes `awaiting` (or `done`/`failed`) it's pushed to `relayQueue` and `schedule()` runs.
   `runJobRelay` (`src/conductor.ts:372`) builds a **seed prompt** for the owner bot. For `awaiting`:

   > `[Background task] {id} ("{task}") needs your input:\n{lastReport}\n\nThis is your own
   > background work. Relay what it needs (first person); when answered, continue_work("{id}",
   > <answer>) to resume it.`

   This is injected as a gate-bypassed forced `respond` turn (`runBotGraph(bot, { seed, surface })`),
   so the bot speaks the question into the #dev channel as itself.

5. **Human answers** — the human replies in chat. The bot, per its persona guidance
   (`src/persona.ts:64-67`), calls `continue_work(jobId, note)` (`src/chat.ts:64`).

6. **Resume** — `continue_work` → `continueWork` (`src/worker.ts:115`): guards that the job is
   `awaiting` and `turns < MAX_TURNS`, sets status back to `running`, and calls
   `runWorkerTurn(jobId, note)` again — **this time with `job.sessionId` set**, so the engine
   *resumes the same session* (Claude `resume`, Codex `resumeThread`, LangGraph `thread_id` +
   checkpointer). The `note` is the new user turn appended to the existing conversation.

So the loop is: `dispatch → run → STATUS: QUESTION → awaiting → relay → human answer → continue_work
→ resume same session → run → …`. Session continuity is preserved across the round-trip by
`sessionId`.

---

## 2. Turns / MAX_TURNS — is multi-turn planning possible today?

- **`MAX_TURNS = 25`** (`src/worker.ts:15`). It is a cap on **worker RUNS** (each full engine
  loop-to-completion), *not* on internal LLM steps. Inside one run, the engine iterates tool-calls
  as many times as it needs.
- **`job.turns` is incremented by one per `runWorkerTurn`** (`src/worker.ts:69`) — once on dispatch,
  once per `continue_work` resume. **`continue_work` does NOT reset the count** — it increments it
  and is guarded by `if (job.turns >= MAX_TURNS)` (`src/worker.ts:123`).
- **Multi-turn planning IS already possible today**, structurally. Each QUESTION → answer →
  `continue_work` cycle resumes the *same engine session*, so the worker keeps full conversational
  context. You could have up to ~25 of these back-and-forths before the cap.

**The real limitation is not mechanical — it's behavioral/UX:**
- The worker's system prompt actively *discourages* stopping to ask (`src/persona.ts:132-145`:
  "Carry it ALL THE WAY TO COMPLETION… Don't stop after one step to check in… don't stop early
  unless you really need a human"). So today the worker will almost never plan-then-ask; it just
  executes.
- Each planning round-trip is **heavyweight**: it goes through a full conductor relay + a chat
  turn + a human reply + another chat turn. That's fine for the occasional genuine blocker, but it's
  a clunky surface for a rapid "let me ask 3 clarifying questions before I start" exchange.

---

## 3. Does the worker get planning guidance today?

**No.** `workerPromptFor(engine, bot)` (`src/persona.ts:129`) is purely execution-oriented:

- Identity line (shared with chat).
- "You are operating in your own background-execution thread… Carry it ALL THE WAY TO COMPLETION
  before you report back — reason, act, observe, and keep going until the whole task is done. Don't
  stop after one step to check in."
- Engine-correct tool guide (`WORKER_TOOL_GUIDE[engine]`).
- The STATUS line contract (DONE / QUESTION / BLOCKED), framed as: "Only QUESTION and BLOCKED
  interrupt your teammate… don't stop early unless you really need a human."

There is **zero** instruction to plan first, ask clarifying questions, or surface unknowns before
acting. The bias is the opposite: just finish.

Note on prompt delivery per engine (matters for where planning guidance lives):
- **Claude** passes `systemPrompt` on *every* run (`src/engines/claude.ts:48`), including resumes.
- **Codex** and **LangGraph** inject `systemPrompt` **only on the first turn**
  (`src/engines/codex.ts:28`, `src/engines/langgraph.ts:37`) — on resume it lives in the
  checkpointed history. So system-prompt-level planning guidance reliably reaches all three engines
  on the *first* run, which is exactly where planning happens. Good.

---

## 4. Where would planning mode hook in?

Ranked by how surgical they are. It is **not** a new engine — the engine seam
(`RunWorkerArgs`/`WorkerEngine`, `src/engines/types.ts`) is execution-agnostic and shouldn't know
about planning phases.

| Hook point | What changes | Effort |
|---|---|---|
| **`workerPromptFor()`** (`src/persona.ts:129`) | Add planning guidance to the system prompt so the worker asks before executing. Reuses the entire existing QUESTION→continue_work loop. | Smallest |
| **`dispatch_job` tool + `Job`** (`src/chat.ts:28`, `src/jobs.ts:11`) | Add a `mode`/`plan` flag so the chat-self can opt a job into planning; thread it to the prompt. | Small |
| **A new chat tool** (`plan_job`) | A sibling to `dispatch_job` that starts a job in planning mode explicitly. | Small–Medium |
| **`Job.phase` state + `runWorkerTurn`/`continueWork`** | Explicit `planning \| executing \| done` lifecycle, with a transition gate ("approve plan" → execute). | Medium |
| **A planning wrapper around the engine** | A higher-order `WorkerEngine` that runs a plan pass, surfaces it, waits for approval, then runs an execute pass. | Largest |

The key realization: **the QUESTION/awaiting/continue_work machinery is already the planning
transport.** A planning question is just a `STATUS: QUESTION`, and an answered plan is just a
`continue_work`. Most of the value is unlocked by *prompting* for it; richer versions add explicit
state and an approval gate on top.

---

## 5. Minimum viable change

**Add planning guidance to the worker system prompt, gated by a per-job flag.** No new engine, no
new transport — it rides the existing QUESTION → `continue_work` loop.

Concretely:

1. **`Job`** (`src/jobs.ts:11`): add `mode?: 'plan' | 'execute'` (default `execute`). Thread it
   through `createJob(...)`.

2. **`dispatch_job`** (`src/chat.ts:28`): add an optional `plan: boolean` (or `mode`) to the tool
   schema + description, e.g. *"set plan=true for ambiguous/large tasks so you ask clarifying
   questions before executing."* Pass it into `createJob`.

3. **`workerPromptFor(engine, bot, mode)`** (`src/persona.ts:129`): when `mode === 'plan'`, prepend a
   planning preamble that flips the default bias, e.g.:

   > *Before doing any work, PLAN. Read just enough to understand the task, then surface what you'd
   > do and any unknowns or decisions you need from me. If anything is ambiguous, end with
   > `STATUS: QUESTION <your questions>` and wait — do NOT start editing yet. Only once the plan is
   > confirmed should you execute it to completion.*

   `runWorkerTurn` (`src/worker.ts:57`) passes `job.mode` into `workerPromptFor`.

That's it. The worker's first run produces a plan + questions → `STATUS: QUESTION` → relays to chat
→ human answers → `continue_work` resumes the same session → worker executes. The cap (25 runs) and
session continuity already support several planning round-trips.

**Tradeoff:** there's no hard guarantee the worker won't touch files during the plan pass — it's
prompt-enforced, not mechanically enforced. For a v0 internal tool that's acceptable (and consistent
with how the existing STATUS contract is "read by the bot, not machine-parsed" — `src/persona.ts:128`).
If you want a hard guarantee, see the richer option (restrict tools to read-only during planning).

---

## 6. Richer implementation — explicit planning phase with state

Layer these on top of the MVP for a real plan→approve→execute lifecycle:

**a. Explicit phase on the Job.**
Add `phase: 'planning' | 'executing' | 'done'` to `Job` (`src/jobs.ts:11`). `dispatch_job` with
`plan=true` starts in `planning`. The worker transitions are driven explicitly rather than inferred
from STATUS alone.

**b. A plan-approval transition (separate from "answer a question").**
Today `continue_work` just feeds a note and resumes. For planning you want an explicit "the plan is
approved, now execute" signal. Two ways:
- Reuse `continue_work` and let the prompt carry intent (simplest), or
- Add an `approve_plan(jobId, edits?)` chat tool that sets `phase = 'executing'`, *re-issues the
  worker prompt in execute mode* (so the "ask first" bias is dropped for the build pass), and
  resumes the session. This makes the gate visible and auditable.

**c. Hard read-only enforcement during planning (Claude/Codex/LangGraph).**
Make the plan pass *physically* unable to mutate, so "plan first" isn't just a request:
- **Claude** (`src/engines/claude.ts`): when planning, pass a reduced `tools`/`allowedTools` set
  (drop `Write`/`Edit`; restrict `Bash` to read-only) — or short-circuit them in `canUseTool`
  (`src/engines/claude.ts:23`) with a deny when a `planning` flag is set. This needs a `planning`
  bit plumbed onto `RunWorkerArgs` (`src/engines/types.ts:20`), which is the one place the engine
  seam would learn about phase. Keep it a single optional boolean to stay engine-agnostic.
- Codex/LangGraph would need analogous tool-restriction (Codex sandbox already exists; LangGraph's
  `workerTools` set could be filtered).

**d. Persist the plan as a first-class artifact.**
Store the approved plan on the Job (`Job.plan?: string`) and/or in the worklog, so `check_job` and
standups can show "here's the plan it's executing." Surface it distinctly from generic progress in
`getJobState` (`src/worker.ts:135`).

**e. Distinct relay framing for plans.**
In `runJobRelay` (`src/conductor.ts:372`), branch on `phase === 'planning'` to frame the relay as
"here's my plan + open questions" rather than the generic "needs your input," so the human knows
they're reviewing a plan, not unblocking a stuck task.

**f. (Optional) Planning round-trip budget.**
A small per-job cap on *planning* turns (separate from `MAX_TURNS`) so a worker can't loop forever
asking questions before it ever executes.

---

## Recommendation

**Ship the MVP (§5) first**, because it delivers the core goal — worker participates in planning by
asking before executing — with a handful of surgical edits and zero changes to the engine seam or
the relay machinery. It's reversible and low-risk for a v0 internal tool.

**Then, if planning proves useful, add the richer layer (§6) incrementally**, in this order of
value:
1. **`Job.phase`** + **distinct plan relay framing** (§6a, §6e) — makes the lifecycle visible.
2. **`approve_plan` transition that re-prompts in execute mode** (§6b) — a clean, auditable gate.
3. **Hard read-only enforcement during planning** (§6c) — only if prompt-level "plan first" proves
   insufficient; this is the one change that reaches into the engine seam, so do it last and behind
   a single `planning` boolean on `RunWorkerArgs`.

Persisting the plan artifact (§6d) and a planning budget (§6f) are nice-to-haves that can come
whenever.

---

## Specific files / functions to touch

**MVP (§5):**
- `src/jobs.ts` — `Job` interface (add `mode?: 'plan' | 'execute'`); `createJob(...)` signature +
  body (accept and store it).
- `src/chat.ts` — `dispatch_job` tool: add `plan`/`mode` to `schema` + `description`; pass to
  `createJob`. (Update the chat persona guidance in `src/persona.ts:51` `chatPromptFor` to mention
  when to plan vs. dispatch directly.)
- `src/persona.ts` — `workerPromptFor(engine, bot, mode?)`: add the planning preamble branch.
- `src/worker.ts` — `runWorkerTurn` (`:57`): pass `job.mode` into `workerPromptFor`.

**Richer (§6), additionally:**
- `src/jobs.ts` — add `phase` (and optionally `plan`) to `Job`; helpers to transition phase.
- `src/chat.ts` — new `approve_plan` tool; add to `CHAT_TOOLS`.
- `src/worker.ts` — `continueWork` / a new `approvePlan` path that flips phase to `executing` and
  re-prompts in execute mode; phase-aware turn accounting.
- `src/conductor.ts` — `runJobRelay` (`:372`): branch relay framing on `phase === 'planning'`.
- `src/engines/types.ts` — add an optional `planning?: boolean` to `RunWorkerArgs` (the only engine-
  seam change).
- `src/engines/claude.ts` — honor `planning` in `WORKER_TOOLS`/`AUTO_APPROVE`/`canUseTool` to deny
  mutations during the plan pass; mirror in `src/engines/codex.ts` and `src/engines/langgraph.ts`.
- `src/worker.ts` — `getJobState` (`:135`): optionally surface the plan distinctly.

---

## Gotchas / notes for the implementer

- **The STATUS contract is bot-read, not machine-strict.** `statusFromReport` only scans the last 5
  lines for the last `STATUS:` match (`src/worker.ts:35-39`). A planning prompt that ends with
  `STATUS: QUESTION <questions>` flows through the existing `awaiting` path unchanged — no parser
  changes needed for the MVP.
- **System prompt only reaches Codex/LangGraph on the first turn** (§3). Put planning guidance where
  the *first* run sees it (the system prompt is fine). Don't rely on changing the system prompt
  mid-session to flip plan→execute for those engines — drive that transition via the resume `note`
  or by re-seeding, not by mutating the system prompt.
- **`continue_work` is owner-scoped and guarded** (`src/chat.ts:64`, `src/worker.ts:115`): only the
  owning bot can resume, only an `awaiting` job under the turn cap. Any `approve_plan` tool must
  apply the same ownership + state guards.
- **Don't add planning awareness to the engine interface unless you do §6c.** The engine seam is
  deliberately execution-only (`src/engines/types.ts` header). Keep planning state in `Job` and the
  prompt for everything except hard tool-restriction.
- **Turn budget:** with the MVP, every planning round-trip burns one of the 25 runs. Watch that a
  chatty planner doesn't exhaust the cap before executing; §6f addresses this if it becomes real.
