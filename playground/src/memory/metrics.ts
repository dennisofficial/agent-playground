/**
 * Session-scoped memory write metrics. Two layers, because the canonical write site (`rememberDeduped`)
 * doesn't know the gate path, but the reconcile passes do:
 *
 *  - GLOBAL counters (`insertCount` / `dedupCount` / `judgeCallCount`) recorded at the write + judge
 *    sites, so EVERY add-path is covered (reconcile, the `remember` tool, approval).
 *  - PER-PATH reconcile tallies recorded from `reconcile.ts`, keyed by the gate `decision`. This is the
 *    denominator for "do silent (acknowledge/ignore) reconciles ever write anything?" — each reconcile
 *    invocation bumps `attempts`, even when it wrote nothing.
 *
 * In-memory, process-lifetime ("this session") — a singleton like `logBus` / `channel`, not persisted.
 * Global and per-path are two VIEWS of the same writes, NOT meant to be summed: a reconcile insert bumps
 * both `insertCount` and `memByPath[d].inserted`; a `remember`-tool insert bumps only `insertCount`.
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

const DECISIONS: Decision[] = ['respond', 'acknowledge', 'ignore'];
const zeroMem = (): MemTally => ({ attempts: 0, inserted: 0, deduped: 0, updated: 0, deleted: 0 });
const zeroTask = (): TaskTally => ({ attempts: 0, added: 0, completed: 0, dropped: 0 });
const byPath = <T>(make: () => T): Record<Decision, T> =>
  Object.fromEntries(DECISIONS.map((d) => [d, make()])) as Record<Decision, T>;
const cloneByPath = <T>(src: Record<Decision, T>): Record<Decision, T> =>
  Object.fromEntries(DECISIONS.map((d) => [d, { ...src[d] }])) as Record<Decision, T>;

let insertCount = 0;
let dedupCount = 0;
let judgeCallCount = 0;
let memByPath = byPath(zeroMem);
let taskByPath = byPath(zeroTask);

/** A durable-memory write landed: 'inserted' = brand-new fact, 'updated' = merged into a near-duplicate. */
export function recordWrite(action: 'inserted' | 'updated'): void {
  if (action === 'inserted') insertCount++;
  else dedupCount++;
}

/** A gray-band dedup judge fired (the only LLM call on the write path; counts in-app and in the CLI). */
export function recordJudgeCall(): void {
  judgeCallCount++;
}

/** One memory-reconcile invocation finished — counted even when it wrote nothing (the denominator). */
export function recordMemoryReconcile(d: Decision, t: Omit<MemTally, 'attempts'>): void {
  const m = memByPath[d];
  m.attempts++;
  m.inserted += t.inserted;
  m.deduped += t.deduped;
  m.updated += t.updated;
  m.deleted += t.deleted;
}

/** One task-reconcile invocation finished — counted even when it wrote nothing (the denominator). */
export function recordTaskReconcile(d: Decision, t: Omit<TaskTally, 'attempts'>): void {
  const m = taskByPath[d];
  m.attempts++;
  m.added += t.added;
  m.completed += t.completed;
  m.dropped += t.dropped;
}

export interface MemoryMetrics {
  insertCount: number;
  dedupCount: number;
  judgeCallCount: number;
  memByPath: Record<Decision, MemTally>;
  taskByPath: Record<Decision, TaskTally>;
}

/** A snapshot of this session's metrics (deep-copied so callers can't mutate the live counters). */
export function getMemoryMetrics(): MemoryMetrics {
  return {
    insertCount,
    dedupCount,
    judgeCallCount,
    memByPath: cloneByPath(memByPath),
    taskByPath: cloneByPath(taskByPath),
  };
}

/** Zero everything — for a fresh session boundary or a test. */
export function resetMemoryMetrics(): void {
  insertCount = 0;
  dedupCount = 0;
  judgeCallCount = 0;
  memByPath = byPath(zeroMem);
  taskByPath = byPath(zeroTask);
}
