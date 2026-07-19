import type { JobMessage } from '@/lib/api/job-api';
import type { LiveBlock } from '@/lib/api/job-stream';
import { indexDurableSubagents, indexLiveSubagents, type SubagentSummary } from '../subagents';

/**
 * DATA GAP — which writer-subagent runs (`implement` / `implement-deep`) executed inside each thread's
 * orchestrator session. This is the data the pipeline TREE needs to nest subagent runs under a thread's
 * execute session (the `/pipeline` read model deliberately doesn't carry them — see below). It does NOT
 * render anything; the visual tree treatment that consumes it lands with the designer handoff.
 *
 * Why client-derived (not `/pipeline`): a thread now runs as ONE Opus orchestrator session = ONE execute
 * engine turn that streams on the `phase:<anchorStepId>` lane and fans implementation out to writer
 * subagents via Task. The backend turn harness merges its per-turn `metaTag` — `{ phaseId: anchorStepId,
 * … }` — into EVERY durable block of that turn, INCLUDING the subagent blocks (which ALSO carry
 * `meta.parentToolUseId`). So a subagent run "belongs to" the build session whose `phaseId` tags its
 * blocks. `DriverStoreService.getPipelineState` is dual-purpose (the web `/pipeline` payload AND the
 * brain's `get_pipeline_state` tool), so attaching subagent transcripts there would pollute the brain's
 * tool payload and still miss LIVE runs. Deriving here instead reuses the SAME subagent index the
 * conversation/step transcript uses — tree and transcript stay in lockstep, and live runs surface
 * immediately (the durable poll only sees them once the turn ends).
 *
 * @see {@link indexDurableSubagents} — the shared transcript-side join (parentToolUseId ↔ meta.id).
 * @see phases.tsx `phaseLane` — the `phase:<anchorStepId>` live lane these runs stream on.
 */

/**
 * Durable: anchorStepId → the subagent runs that executed inside that session, in spawn order.
 *
 * Subagents spawned on the brain's main turn (e.g. an `explore` during planning) carry no `phaseId`, so
 * they belong to no build session and are correctly omitted — only the per-thread execute fan-out appears.
 */
export function durableSubagentRunsByPhase(messages: JobMessage[]): Map<string, SubagentSummary[]> {
  const { summaryById } = indexDurableSubagents(messages);
  if (summaryById.size === 0) return new Map();

  // Resolve each subagent's owning phase from ANY of its tagged blocks — the spawning Task anchor
  // (`meta.id === parentId`) or a child block (`meta.parentToolUseId === parentId`). Both carry the
  // turn's `phaseId`, so either resolves it.
  const phaseByParent = new Map<string, string>();
  for (const m of messages) {
    const phaseId = typeof m.meta?.phaseId === 'string' ? m.meta.phaseId : null;
    if (!phaseId) continue;
    const parent = typeof m.meta?.parentToolUseId === 'string' ? m.meta.parentToolUseId : null;
    if (parent && summaryById.has(parent)) phaseByParent.set(parent, phaseId);
    const id = typeof m.meta?.id === 'string' ? m.meta.id : null;
    if (id && summaryById.has(id)) phaseByParent.set(id, phaseId);
  }

  // `summaryById` iterates in spawn order (anchor message order), so each phase's list stays ordered.
  const byPhase = new Map<string, SubagentSummary[]>();
  for (const [parentId, summary] of summaryById) {
    const phaseId = phaseByParent.get(parentId);
    if (!phaseId) continue;
    const arr = byPhase.get(phaseId);
    if (arr) arr.push(summary);
    else byPhase.set(phaseId, [summary]);
  }
  return byPhase;
}

/**
 * Live: the subagent runs streaming on ONE phase lane (`phase:<anchorStepId>`), in spawn order. The lane
 * is already phase-scoped — every run on it belongs to that session — so no `phaseId` filtering is needed.
 * Only one thread executes at a time, so the tree subscribes to just the active thread's lane.
 */
export function liveSubagentRunsForPhase(laneBlocks: LiveBlock[]): SubagentSummary[] {
  return [...indexLiveSubagents(laneBlocks).summaryById.values()];
}

/**
 * Durable: anchorStepId -> the orchestrator session's OWN tool count (the session-line "· N tools"). Counts
 * tool blocks tagged to the phase but NOT belonging to a writer subagent — the subagents carry their own
 * tool counts on each run row, so excluding them keeps the session total from double-counting the fan-out.
 */
export function durableSessionToolCounts(messages: JobMessage[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const m of messages) {
    if (m.kind !== 'tool') continue;
    const phaseId = typeof m.meta?.phaseId === 'string' ? m.meta.phaseId : null;
    if (!phaseId) continue;
    if (typeof m.meta?.parentToolUseId === 'string') continue; // a writer subagent's tool, not the session's
    counts.set(phaseId, (counts.get(phaseId) ?? 0) + 1);
  }
  return counts;
}
