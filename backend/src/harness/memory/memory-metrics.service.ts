import { Injectable } from '@nestjs/common';

/**
 * Session-scoped memory write metrics. Two layers, because the canonical write site
 * (`MemoryWriteService.rememberDeduped`) doesn't know the gate path, but the reconcile passes do:
 *
 *  - GLOBAL counters (insert/dedup/judge) recorded at the write + judge sites, so EVERY add-path is
 *    covered (reconcile, the `remember` tool).
 *  - PER-PATH reconcile tallies keyed by the gate `decision` — the denominator for "do silent
 *    (acknowledge/ignore) reconciles ever write anything?" Each invocation bumps `attempts`, even
 *    when it wrote nothing.
 *
 * In-memory, process-lifetime ("this session"). Global and per-path are two VIEWS of the same
 * writes, NOT meant to be summed. (Ported from playground/src/memory/metrics.ts.)
 */

export type Decision = 'respond' | 'acknowledge' | 'ignore';

export interface MemTally {
  attempts: number;
  inserted: number;
  deduped: number;
  updated: number;
  deleted: number;
}

export interface TaskTally {
  attempts: number;
  added: number;
  completed: number;
  dropped: number;
}

export interface MemoryMetrics {
  insertCount: number;
  dedupCount: number;
  judgeCallCount: number;
  memByPath: Record<Decision, MemTally>;
  taskByPath: Record<Decision, TaskTally>;
}

const DECISIONS: Decision[] = ['respond', 'acknowledge', 'ignore'];
const zeroMem = (): MemTally => ({
  attempts: 0,
  inserted: 0,
  deduped: 0,
  updated: 0,
  deleted: 0,
});
const zeroTask = (): TaskTally => ({
  attempts: 0,
  added: 0,
  completed: 0,
  dropped: 0,
});
const byPath = <T>(make: () => T): Record<Decision, T> =>
  Object.fromEntries(DECISIONS.map((d) => [d, make()])) as Record<Decision, T>;
const cloneByPath = <T extends object>(
  src: Record<Decision, T>,
): Record<Decision, T> =>
  Object.fromEntries(DECISIONS.map((d) => [d, { ...src[d] }])) as Record<
    Decision,
    T
  >;

@Injectable()
export class MemoryMetricsService {
  private insertCount = 0;
  private dedupCount = 0;
  private judgeCallCount = 0;
  private memByPath = byPath(zeroMem);
  private taskByPath = byPath(zeroTask);

  /** A durable-memory write landed: 'inserted' = brand-new fact, 'updated' = merged into a near-duplicate. */
  recordWrite(action: 'inserted' | 'updated'): void {
    if (action === 'inserted') this.insertCount++;
    else this.dedupCount++;
  }

  /** A gray-band dedup judge fired (the only LLM call on the write path). */
  recordJudgeCall(): void {
    this.judgeCallCount++;
  }

  /** One memory-reconcile invocation finished — counted even when it wrote nothing (the denominator). */
  recordMemoryReconcile(d: Decision, t: Omit<MemTally, 'attempts'>): void {
    const m = this.memByPath[d];
    m.attempts++;
    m.inserted += t.inserted;
    m.deduped += t.deduped;
    m.updated += t.updated;
    m.deleted += t.deleted;
  }

  /** One task-reconcile invocation finished — counted even when it wrote nothing (the denominator). */
  recordTaskReconcile(d: Decision, t: Omit<TaskTally, 'attempts'>): void {
    const m = this.taskByPath[d];
    m.attempts++;
    m.added += t.added;
    m.completed += t.completed;
    m.dropped += t.dropped;
  }

  /** A snapshot of this session's metrics (deep-copied so callers can't mutate the live counters). */
  snapshot(): MemoryMetrics {
    return {
      insertCount: this.insertCount,
      dedupCount: this.dedupCount,
      judgeCallCount: this.judgeCallCount,
      memByPath: cloneByPath(this.memByPath),
      taskByPath: cloneByPath(this.taskByPath),
    };
  }

  /** Zero everything — for a fresh session boundary or a test. */
  reset(): void {
    this.insertCount = 0;
    this.dedupCount = 0;
    this.judgeCallCount = 0;
    this.memByPath = byPath(zeroMem);
    this.taskByPath = byPath(zeroTask);
  }
}
