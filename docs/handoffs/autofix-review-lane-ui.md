# Design Handoff: Make the auto-fix / review stage visible in the transcript

**For:** Claude design (Atlas Design System — `dda2eee5-bb8f-4b54-aca6-ea89e04a920f` on claude.ai/design)
**Deliverable:** a HiFi `.dc.html` mock (conversation + right-pane sub-page + navigator states), matching the prior Atlas Workspace mocks.
**Type:** new render surface for an existing-but-invisible backend stage. The backend streaming has LANDED (see the data contract below); you design how it renders.

---

## Data contract (backend — LANDED, this is what you bind to)

The auto-fix stage now rides the shared transcript spine exactly like Codex review. Mirror the `codex-review.tsx` peel:

- **Lanes** (the live SSE stream): stage node `autofix:<autofixId>` · per-lens `autofix:<autofixId>:<lensId>` · fix turn `autofix:<autofixId>:fix`. `<autofixId>` is the **thread id** for a per-thread pass and the **job id** for the PR-tail pass. (Lenses run concurrently, hence per-lens sub-lanes.)
- **Durable block meta** (on every `chat`/`thinking`/`tool` row): `{ autofixId, scope: 'thread' | 'pr', lensId? , fixTurn? }`. Peel these out of Main by `meta.autofixId` (as codex-review peels by `meta.codexReviewId`); group by `lensId` for the per-lens sub-runs; `fixTurn: true` marks the single fix turn.
- **Anchor row** (the in-conversation card hook): `kind: 'autofix_anchor'`, `meta: { autofixId, autofixAnchor: true, scope, label, lensIds }`, paired with a visible milestone post so it wakes the client at stage start. Latch the card onto `meta.autofixAnchor` (as codex-review does on `meta.codexReviewAnchor`).
- **Per-lens status dots** (the navigator): per-thread lenses are on `PipelineThread.reviewAgents` (already rendered); the **PR-tail** lenses are now on a new job-level `PipelineJob.reviewAgents` (`ReviewAgent[]`, same shape) — render these under the job-level **"Final review"** node.

Node keys to open the lane sub-page (your choice, but suggest): `autofix:<autofixId>` for the stage, reusing the existing `TranscriptView` with `lane` set + a `buildLogItems` branch that includes `meta.autofixId` blocks (grouped by `lensId`). Replace the placeholder `ReviewView` at `web/src/features/job-workspace/step-view.tsx`.

---

## TL;DR — the ask

After a build thread finishes coding, Atlas runs an **auto-fix / review stage**: a fan-out of parallel review "lenses" over the diff, then one fix turn. It runs **real engine turns but renders nothing** — so a thread that's actually working through review looks *done* in the transcript while its status pulses **"running."** You can't tell working from hung. Design the rendering so this stage is legible, mirroring the existing **Codex review lane** pattern.

There are **two** invisible instances of this stage:
1. **Per-thread auto-fix** — runs after each build thread's steps (thread status `auto_fixing`, pulses "running").
2. **PR-tail auto-fix** — runs once after all threads, over the whole feature diff, **before the PR opens** (job status `running`, "No PR yet"). This is the classic "looks stuck" case and today has **zero** UI.

---

## Orientation: how the Atlas workspace is built (read first)

Three panes: **navigator** (left tree) · **conversation** (center) · **detail pane** (right).

Everything is a **lane** on one shared transcript renderer. Main (the brain), Codex review, and each build thread/step are all lanes. **Deeper lanes peel out of the conversation into a compact CARD that opens a full sub-page** in the detail pane. This "same transcript, just nested" model is the whole design language — match it.

**Precedents to mirror (these already ship):**

| Surface | Card in conversation | Opens | Icon / avatar |
|---|---|---|---|
| **Codex review** ← *closest analog* | `CodexReviewCard` — "round N", "N findings", pulses "reviewing", **Open transcript →** | `codex-review:<jobId>` lane sub-page (Codex's reasoning, file reads, findings, rebuttals) | `ShieldCheck`, slate avatar |
| Build step | `BuildStepCard` — "N steps batched", tool count, pulses "building", **Viewing run →** | step sub-page | `Hammer`, accent avatar |
| Subagent | `SubagentCard` — **Viewing run →** | subagent sub-page (its own thinking + tools) | diamond |

Card anatomy (all three): `rounded-[10px]` bordered panel, 6px gradient avatar, bold `[12.5px]` title, uppercase `font-mono` micro-labels for round/count/status, a pulse-dot while active, and an accent "open" button on the right. **Running state** = `--accent-line` border + `--accent-soft` fill + pulse-dot. **Idle** = `--border` + faint surface tint.

**Navigator** already shows a per-thread **review folder** with one leaf per lens, each carrying a **status dot** (pending / running / passed / failed / skipped) and a findings count. But clicking a lens leaf today opens a **placeholder** ("findings aren't browsable here yet") — that's the gap.

---

## What to design

### A. The review-lane sub-page (replaces today's placeholder `ReviewView`)

Turn the placeholder into a real transcript of the stage. It's a **fan-out**, so treat each lens like a peel-out run (same model as subagents):

- **Lens fan-out list** — one row per lens (e.g. *correctness*, *security*, *tests*, *style*…). Each row: label · status dot · findings count · expandable/clickable into **that lens's own reasoning transcript** (thinking + file reads / tool calls + the findings it reported). Lenses run in parallel (capped), so several can be "running" at once.
- **Aggregated findings** — the deduped, severity-tagged set that survived (findings carry a severity; only those ≥ a threshold drive a fix). Show severity visually.
- **The fix turn** — one execute turn that applies the actionable fixes: what it changed + the resulting **commit** (short sha + message). Or the empty states below.
- **Empty / short-circuit states** — "0 changed files — nothing to review" (skips the whole fan-out); "findings found, but none met the fix threshold"; "fix turn made no changes."

### B. The in-conversation card (the anchor that opens A)

An **auto-fix card** that stands in for the stage in the transcript, styled as a sibling of `CodexReviewCard`. States to render:

- `pending` (queued) · `running` (pulse — "reviewing the diff") · `passed / clean` (0 findings) · `passed with fixes` (*N lenses · M findings · K fixes committed*) · `findings, no fix` (below threshold) · `failed lens` (a lens dropped) · `skipped` (empty diff).
- **Distinct icon** from Codex's `ShieldCheck` and build's `Hammer` — suggest a **scan / wand / wrench-over-shield**. Pick something that reads "automated cleanup pass," not "human review gate."
- **Two variants:** per-thread ("Auto-fix · <thread brief>") and **PR-tail** ("Final review — whole PR diff"). The PR-tail one lives on the job's top level, not inside a thread.

### C. Navigator

- **Per-thread review folder** — keep the per-lens dots; make the leaf open the real lens transcript from **(A)** instead of the placeholder.
- **PR-tail auto-fix has no nav home today** — add a job-level node (sibling to **Codex review** / **Main**), e.g. **"Final review"**, that opens the PR-tail lane.
- **Legibility of "running"** — the core bug is that `auto_fixing` and a stuck job both read as a generic pulsing "running." Consider a status affordance (label/sublabel/tooltip) that says *what* is running ("reviewing the diff — 3 lenses") so the operator can tell progress from a hang.

---

## Data you can bind to

Per lens (already exposed per thread via the pipeline read model, `ReviewAgent`):

```ts
interface ReviewAgent {
  id: string;
  label: string;
  status: 'pending' | 'running' | 'passed' | 'failed' | 'skipped';
  findings?: number; // set once it has run
}
```

Once the backend streams the stage (in progress), you also get, on the lane:
- **Per-lens transcript blocks** and the **fix-turn** transcript — same `SubBlock` shape (thinking / tool / text) the subagent + build-phase sub-pages already render.
- **Findings** with a **severity** (low/medium/high) — deduped; "actionable" = ≥ medium by default.
- **Commit(s)** from the fix turn (`sha` + message), e.g. `chore(autofix): thread review fixes`.

The **PR-tail** stage runs over `origin/<base>...HEAD` and currently emits **no** per-lens status at all — its lens list + statuses need the same treatment as the per-thread one.

---

## States checklist (please cover all)

`pending` · `running` (per-lens **and** overall) · `passed / clean` (0 findings) · `passed with fixes` (N findings → K fixes committed) · `findings but no fix` (below severity threshold) · `failed lens` (one lens dropped, others continue) · `empty-diff skipped` · **PR-tail variant** (job-level) · **long-running vs. hung** (how does a legitimately slow pass read differently from a stall?).

---

## Design system & constraints

- **Tokens:** `--accent` / `--accent-soft` / `--accent-line` (running + pulse) · `--green` / `--green-soft` (passed/clean) · `--red` / `--red-soft` (failed / findings) · `--slate` (Codex — avoid, keep auto-fix distinct) · `--border` / `--surface-2` / `--surface-3` (panels) · `--text` / `--dim` / `--faint` · `font-mono` for uppercase micro-labels and status.
- **Match the family:** the auto-fix card should read as a sibling of `CodexReviewCard`. Same geometry (`rounded-[10px]`, 6px avatar, accent open-button), same restraint as the navigator tree.
- Additive — don't redesign the navigator or conversation shell.

---

## Engineering reference (where it lands — for context, not for you to build)

- Card + lane index: new file alongside `web/src/features/job-workspace/codex-review.tsx` (copy that exact pattern).
- Sub-page: replaces the placeholder `ReviewView` in `web/src/features/job-workspace/step-view.tsx` (~line 476).
- Navigator: `web/src/features/job-workspace/navigator.tsx` + `pipeline-tree.tsx` (review folder leaves + new PR-tail node).
- Types: `web/src/lib/api/types.ts` (`ReviewAgent` exists; extend for the lane + PR-tail).
- Backend seam (why it's invisible today): `backend/src/app/autofix/autofix.stage.ts` calls `EngineRunnerPort.run(...)` directly (no lane / block sink / rich stream); `build-ship.service.ts` invokes the PR-tail pass with no status wiring. Both get routed onto the transcript spine as part of this work — you consume the rendered lane.

## Not in scope
- The backend streaming wiring (engineering, in progress).
- Redesigning Codex review, build-step, or subagent surfaces — only align with them.
