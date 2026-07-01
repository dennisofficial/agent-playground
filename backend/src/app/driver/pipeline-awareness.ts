import type { PipelineMarker } from '../persistence/entities/job.entity';

export type { PipelineMarker };

/**
 * PASSIVE pipeline-milestone awareness — the PURE half (signature / summary / prefix). No I/O, no Nest.
 *
 * The brain (the in-sandbox Claude Code session) only ever sees what a turn FEEDS it; messages appended
 * to the durable log out-of-band are never replayed into its SDK context. So while a build runs the brain
 * is blind to it. This module turns the `get_pipeline_state` read model + a buffer of explicit milestones
 * into a clearly-passive prefix that the next OPERATOR turn prepends — the brain then KNOWS where the
 * build stands without being streamed events or woken into a turn.
 *
 * Two sources, by design (see `ARCHITECTURE.md` / the buffer column doc):
 *  - the STATE SIGNATURE — the net "where things stand now" spine. Self-healing across restarts, but the
 *    driver overwrites thread/step status in place, so it can only report the CURRENT state, never the
 *    transient stages it passed through.
 *  - explicit MARKERS (durable, in the buffer) — the transient moments the signature can't reconstruct
 *    (plan approved, dispatched, a thread/guard stage finished, auto-fix applied).
 */

/** The slice of the `get_pipeline_state` read model this module reads. Everything optional — the model is
 *  `{ status: 'no_job' }` before the thread enters the build lifecycle. */
interface PipelineStateView {
  status?: string;
  decisionRecordId?: string | null;
  prUrl?: string | null;
  threads?: Array<{
    id?: string;
    ordinal?: number;
    brief?: string;
    status?: string;
    steps?: Array<{ id?: string; stage?: string; status?: string }>;
  }>;
}

/** True once the thread has entered the build lifecycle (a real pipeline state, not `no_job`/`open`).
 *  `get_pipeline_state` already maps an un-scoped thread to `{ status: 'no_job' }`; `open` is guarded too
 *  for defensiveness (a plain conversation has no build to report). */
function isLivePipeline(s: PipelineStateView | null | undefined): s is PipelineStateView {
  return !!s && s.status != null && s.status !== 'no_job' && s.status !== 'open';
}

/**
 * A deterministic signature of the net pipeline state — the watermark the next turn diffs against. Returns
 * null when there is no build to report (so nothing is ever conveyed for a plain conversation). Scoped by
 * `decisionRecordId`, so a RE-PROPOSAL (which mints a new record + fresh thread rows) naturally changes
 * the signature and re-conveys, with no stale ordinal/thread-id watermark to reset.
 */
export function pipelineStateSignature(state: unknown): string | null {
  const s = state as PipelineStateView;
  if (!isLivePipeline(s)) return null;
  const parts = [`dr:${s.decisionRecordId ?? ''}`, `st:${s.status}`, `pr:${s.prUrl ?? ''}`];
  for (const sec of s.threads ?? []) {
    parts.push(`s${sec.ordinal ?? '?'}:${sec.status ?? '?'}`);
    for (const p of sec.steps ?? []) {
      parts.push(`p${(p.id ?? '').slice(0, 8)}:${p.stage ?? '?'}/${p.status ?? '?'}`);
    }
  }
  return parts.join('|');
}

/**
 * A concise human summary of WHERE THE BUILD STANDS NOW (the net current state). Best-effort freshness,
 * not authoritative — `get_pipeline_state` is the pull the brain trusts; this is the prepend so it doesn't
 * have to ask. Empty string when there is no build to report.
 */
export function renderPipelineStateSummary(state: unknown): string {
  const s = state as PipelineStateView;
  if (!isLivePipeline(s)) return '';
  const lines = [`Current build state: ${s.status}.`];
  if (s.prUrl) lines.push(`PR: ${s.prUrl}`);
  for (const sec of s.threads ?? []) {
    const steps = sec.steps ?? [];
    const phaseBit = steps.length
      ? ` [${steps.filter((p) => p.status === 'done').length}/${steps.length} steps done]`
      : '';
    lines.push(`  • Thread ${sec.ordinal ?? '?'} "${sec.brief ?? ''}": ${sec.status ?? '?'}${phaseBit}`);
  }
  return lines.join('\n');
}

/**
 * Render the clearly-PASSIVE prefix prepended to an operator turn. Framed as information, not a command,
 * so the brain reads it as context — it must KNOW the milestone, not ACT on it. Returns '' when there is
 * nothing to convey (the caller skips the prepend entirely).
 */
export function renderAwarenessPrefix(
  markers: PipelineMarker[],
  stateSummary: string | null,
): string {
  if (markers.length === 0 && !stateSummary) return '';
  const parts = [
    'Pipeline updates since your last message — informational, no action needed unless asked:',
  ];
  for (const m of markers) parts.push(`- ${m.text}`);
  if (stateSummary) parts.push('', stateSummary);
  return parts.join('\n');
}
