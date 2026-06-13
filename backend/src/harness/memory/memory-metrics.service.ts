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

/**
 * Phase 2+: per-path memory suggestion tallies (replaces write counts — all writes now go through
 * the agent's own tools, tracked by `recordWrite`). Each reconcileMemory pass records how many
 * suggestions it surfaced by qualifying class.
 */
export interface MemTally {
  attempts: number;
  corrections: number; // explicit-correction suggestions surfaced
  decisions: number; // stated-decision suggestions surfaced
  preferences: number; // explicit-preference suggestions surfaced
}

export interface TaskTally {
  attempts: number;
  added: number;
  completed: number;
  dropped: number;
}

/** Recall-side health: not just whether memory is WRITTEN, but whether it SURFACES when needed. */
export interface RecallTally {
  /** Fetch passes that attempted recall (a non-empty retrieval query). The denominator. */
  attempts: number;
  /** Passes that surfaced at least one fact — the live recall hit-rate is hits / attempts. */
  hits: number;
  /** Total facts injected across all passes — facts / attempts is the average context depth. */
  factsInjected: number;
}

/**
 * Periodic memory consolidation counters (Phase 7). Accumulated across all runs until `reset()`.
 * Each `recordConsolidation` call represents ONE scope's outcome; the service sums them.
 */
export interface ConsolidationTally {
  scopesScanned: number;
  /** Facts soft-deleted as part of a merge (dupes collapsed into the survivor). */
  merged: number;
  /** Facts soft-deleted as clearly stale. */
  dropped: number;
  /** Contradiction pairs flagged for human/agent review (NOT auto-resolved). */
  contradictionsFlagged: number;
  /** Per-scope errors that were swallowed (fire-and-forget). */
  errors: number;
}

export interface MemoryMetrics {
  insertCount: number;
  dedupCount: number;
  judgeCallCount: number;
  memByPath: Record<Decision, MemTally>;
  taskByPath: Record<Decision, TaskTally>;
  recall: RecallTally;
  consolidation: ConsolidationTally;
}

const DECISIONS: Decision[] = ['respond', 'acknowledge', 'ignore'];
const zeroMem = (): MemTally => ({
  attempts: 0,
  corrections: 0,
  decisions: 0,
  preferences: 0,
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

const zeroConsolidation = (): ConsolidationTally => ({
  scopesScanned: 0,
  merged: 0,
  dropped: 0,
  contradictionsFlagged: 0,
  errors: 0,
});

@Injectable()
export class MemoryMetricsService {
  private insertCount = 0;
  private dedupCount = 0;
  private judgeCallCount = 0;
  private memByPath = byPath(zeroMem);
  private taskByPath = byPath(zeroTask);
  private recall: RecallTally = { attempts: 0, hits: 0, factsInjected: 0 };
  private consolidation: ConsolidationTally = zeroConsolidation();

  /** A durable-memory write landed: 'inserted' = brand-new fact, 'updated' = merged into a near-duplicate. */
  recordWrite(action: 'inserted' | 'updated'): void {
    if (action === 'inserted') this.insertCount++;
    else this.dedupCount++;
  }

  /** A gray-band dedup judge fired (the only LLM call on the write path). */
  recordJudgeCall(): void {
    this.judgeCallCount++;
  }

  /**
   * One memory-reconcile invocation finished — counted even when it surfaced nothing (the
   * denominator). Phase 2+: counts suggestions by qualifying class, not writes (writes go through
   * the agent's own tools and are captured by `recordWrite`).
   */
  recordMemoryReconcile(d: Decision, t: Omit<MemTally, 'attempts'>): void {
    const m = this.memByPath[d];
    m.attempts++;
    m.corrections += t.corrections;
    m.decisions += t.decisions;
    m.preferences += t.preferences;
  }

  /** One task-reconcile invocation finished — counted even when it wrote nothing (the denominator). */
  recordTaskReconcile(d: Decision, t: Omit<TaskTally, 'attempts'>): void {
    const m = this.taskByPath[d];
    m.attempts++;
    m.added += t.added;
    m.completed += t.completed;
    m.dropped += t.dropped;
  }

  /** One pre-LLM fetch attempted recall (non-empty query). `factCount` = facts injected this pass
   * (0 = the store had nothing relevant). Tracks whether memory SURFACES, not just whether it's written. */
  recordRecall(factCount: number): void {
    this.recall.attempts++;
    if (factCount > 0) this.recall.hits++;
    this.recall.factsInjected += factCount;
  }

  /**
   * Record the outcome of one scope's consolidation pass. Call once per scope whether the pass
   * produced anything or not (scopesScanned is the denominator). Errors are counted separately so
   * the consolidation loop can swallow them without losing observability.
   */
  recordConsolidation(t: Omit<ConsolidationTally, 'scopesScanned'>): void {
    this.consolidation.scopesScanned++;
    this.consolidation.merged += t.merged;
    this.consolidation.dropped += t.dropped;
    this.consolidation.contradictionsFlagged += t.contradictionsFlagged;
    this.consolidation.errors += t.errors;
  }

  /** A snapshot of this session's metrics (deep-copied so callers can't mutate the live counters). */
  snapshot(): MemoryMetrics {
    return {
      insertCount: this.insertCount,
      dedupCount: this.dedupCount,
      judgeCallCount: this.judgeCallCount,
      memByPath: cloneByPath(this.memByPath),
      taskByPath: cloneByPath(this.taskByPath),
      recall: { ...this.recall },
      consolidation: { ...this.consolidation },
    };
  }

  /** Zero everything — for a fresh session boundary or a test. */
  reset(): void {
    this.insertCount = 0;
    this.dedupCount = 0;
    this.judgeCallCount = 0;
    this.memByPath = byPath(zeroMem);
    this.taskByPath = byPath(zeroTask);
    this.recall = { attempts: 0, hits: 0, factsInjected: 0 };
    this.consolidation = zeroConsolidation();
  }
}
