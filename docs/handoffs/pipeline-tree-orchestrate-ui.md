# Handoff: Pipeline-tree UI for the per-track orchestrator model

## Why
The build was reworked so **each track runs as ONE Opus orchestrator session** that fans the
implementation out to **writer subagents** (`implement` Sonnet / `implement-deep` Opus) via the Task tool
(HYBRID — the orchestrator also makes small edits directly). But the pipeline tree still renders the OLD
plan shape (`track → plan / execute → step 1, step 2… / review`), which reads like the pre-orchestrate
"each step is its own execution" model AND never shows the subagent fan-out. The tree should reflect the
execution model: one session per track, with its writer-subagent runs nested.

## Current state (what renders today)
- `web/src/features/thread-workspace/pipeline-tree.tsx` — 4-level tree:
  `track → plan(optional) / execute / review → step leaves (under execute) + review-agent "lenses" (under review)`.
  - `groupBatches(steps)` already groups steps by shared `anchorStepId` (a batch = one engine turn = one
    transcript). An in-flight multi-step batch (all `building`) collapses into ONE combined card; otherwise
    steps render as individual leaves.
  - Clicking a step selects `anchorStepId` → the batch's single transcript.
- `web/src/features/thread-workspace/navigator.tsx` renders `<PipelineTree>` + the state banners.
- `web/src/features/thread-workspace/step-view.tsx` — the step sub-page. Subagent runs ALREADY peel out
  here into a `SubagentCard`/nested transcript via `meta.parentToolUseId` (+ `meta.id`). This is the only
  place the subagent fan-out is visible — NOT the tree.
- `review` node + its "lenses" are placeholders (a seam — backend runs a fixed review/autofix set; see the
  `atlas-dynamic-review-agents` work). The orchestrator now self-verifies in-turn, so a separate review
  phase oversells.

## Desired
1. **execute = one orchestrator session** per track (not N discrete step runs). Keep the plan's steps as
   the session's checklist/decomposition (they all open the same anchor transcript), but stop implying
   per-step execution.
2. **Nest the writer-subagent runs** (`implement`/`implement-deep`) under that session in the tree — the
   same runs `SubagentCard` shows in the transcript, made structural. This is the "single session with
   subagents" view the operator expects.
3. **Reconcile the `review` node** given in-turn verification (soften or fold it in).

## Backend model (ground truth)
- `ORCHESTRATE_TRACKS` (default on) → `driver/track-driver.service.ts` `executeSteps` collapses a track
  into ONE batch → `runBatch` = ONE execute engine turn (`ORCHESTRATE_EXECUTE_SYSTEM`).
- Subagent blocks are durable `messages` rows with `meta.parentToolUseId` set (the spawning Task id) and
  `meta.id`; the engine forwards them via `forwardSubagentText` (richStream). `meta.phaseId` ties build
  blocks to the anchor step.
- The `/pipeline` read model: `driver/driver-store.service.ts` `getPipelineState` + `mapBatchedSteps`
  exposes steps with `anchorStepId` / `batchStepIds` — but does NOT expose subagent runs.

## Data gap to solve first
To nest subagents in the TREE you need subagent-run data in the tree's data source. Options:
- (a) Extend the `/pipeline` read model to include each track-session's subagent runs (group `messages`
  by `meta.parentToolUseId` under the anchor step), OR
- (b) Derive them on the client from the thread `messages` (the transcript already does this via
  `parentToolUseId`) and join into the tree.
Pick one; (a) keeps the tree's single read model authoritative.

## Files
- `web/src/features/thread-workspace/pipeline-tree.tsx` (tree structure — main change)
- `web/src/features/thread-workspace/navigator.tsx` (renders the tree)
- `web/src/features/thread-workspace/step-view.tsx` (existing SubagentCard nesting — reuse its model)
- `web/src/lib/api/types.ts` (pipeline types) + `backend/src/app/driver/driver-store.service.ts`
  (`getPipelineState`/`mapBatchedSteps`) if exposing subagent runs server-side.

## Constraints
- `web/AGENTS.md`: "This is NOT the Next.js you know — read `node_modules/next/dist/docs/` before
  framework code." (This task is mostly React tree rendering; heed it if you touch routing/data-fetching.)
- Match the navigator's restrained palette/tokens (the existing tree design language).
- A **designer `/design-sync` handoff is coming** — incorporate it; this handoff is the engineering context.
- Uncommitted work on `main` (subagent orchestration, events-as-harness-messages, a context-occupancy
  fix, a pnpm-store/commitAll fix). Work ADDITIVELY; don't revert.

## Validation
- `cd web && pnpm typecheck` + `pnpm build` green.
- Live (playwright/Claude-in-Chrome vs `:4002`): a track that ran the orchestrator shows one session with
  its `implement` subagent run(s) nested; clicking opens the right transcript.

## Related (do NOT fold in — separate chips/issues)
- `task_ce3cabea` pnpm-store/commitAll (builds can't reach a PR until that lands — needed to get a fully
  green orchestrate run to look at live).
- `task_398da566` context-occupancy %.
- Driver `post()` milestones silently don't reach web threads (observability gap).
