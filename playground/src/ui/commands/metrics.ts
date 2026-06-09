import { type Decision, getMemoryMetrics } from '../../memory/metrics.js';
import type { Command } from './types.js';

/**
 * `/metrics` — print this session's memory write metrics. Two views: the GLOBAL totals (facts saved vs
 * deduped, plus gray-band judge calls), and the PER-GATE-PATH write rate (`writes / reconcile attempts`).
 * The `ignore` / `acknowledge` columns are the signal the deferred "should silent bots reconcile at all?"
 * decision reads — a low write rate there means those reconciles rarely earn their Haiku cost. Local-only
 * output (a `note` row), never a channel message.
 */
const PATHS: Decision[] = ['respond', 'acknowledge', 'ignore'];

export const metricsCommand: Command = {
  name: 'metrics',
  summary: '/metrics — memory write stats this session (saved/deduped, judge calls, per gate path)',
  run(text, ctx) {
    if (!/^\/metrics$/i.test(text)) return false;
    const m = getMemoryMetrics();
    // Per gate path, NEW (inserted) is kept SEPARATE from dup (deduped) on purpose. On a silent
    // (ignore/acknowledge) path a dedup is redundant — the fact was already captured (typically by the
    // responder, who writes first under the shared lock), so cutting that path loses nothing. A NEW fact
    // is the opposite: something no responder caught, and the only thing cutting silent reconcile would
    // actually lose. Collapsing the two into one "writes" total would read "ignore is busy, keep it" when
    // the truth is usually "all dups, safe to cut" — the exact wrong signal for the deferred Change-1 call.
    // Counts are RECONCILE-only: `remember`-tool saves land in the global totals above, not these buckets.
    const memLine = PATHS.map((d) => {
      const t = m.memByPath[d];
      return `${d} ${t.inserted}new ${t.deduped}dup /${t.attempts}`;
    }).join('  ·  ');
    const taskLine = PATHS.map((d) => {
      const t = m.taskByPath[d];
      return `${d} ${t.added}new /${t.attempts}`;
    }).join('  ·  ');
    ctx.note(
      `Memory this session: +${m.insertCount} saved, ≈${m.dedupCount} deduped, ${m.judgeCallCount} judge calls`,
    );
    ctx.note(`  reconcile facts by gate path (new/dup/attempts):  ${memLine}`);
    ctx.note(`  reconcile reminders by gate path (new/attempts):  ${taskLine}`);
    return true;
  },
};
