/**
 * Pure, framework-free helpers for the task-list dependency edges (`blocked_by`). Extracted from the
 * departed `driver/task-fold.ts` so BOTH `EntityTaskEventSink.createTask`/`updateTask` reuse one copy and
 * the web can mirror the exact same set logic client-side. No TypeORM types here — trivially unit-testable.
 */

export const isStr = (v: unknown): v is string => typeof v === 'string';

/** Coerce an unknown input field to a string[] (a non-array, or non-string members, are dropped). */
export const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter(isStr) : []);

/**
 * A task's FORWARD dependency edges after applying a `task_create`/`task_update` input:
 * `prev ∪ blockedBy ∪ addBlockedBy ∖ removeBlockedBy`, deduped. Ids that aren't real strings are dropped.
 */
export function mergeBlockedBy(prev: string[], input: Record<string, unknown>): string[] {
  const remove = new Set(strArr(input.removeBlockedBy));
  return [
    ...new Set([...prev.filter(isStr), ...strArr(input.blockedBy), ...strArr(input.addBlockedBy)]),
  ].filter((b) => !remove.has(b));
}

/** True when the input carries any forward-edge field, so `blocked_by` should be recomputed on update. */
export function hasBlockedByInput(input: Record<string, unknown>): boolean {
  return (
    input.blockedBy !== undefined ||
    input.addBlockedBy !== undefined ||
    input.removeBlockedBy !== undefined
  );
}

/** One INVERSE edge to apply: "this task blocks `targetId`" → add/remove the source id on the target's
 *  `blocked_by`. `addBlocks` yields `add` ops, `removeBlocks` yields `remove` ops. */
export type InverseEdgeOp = {
  targetId: string;
  op: 'add' | 'remove';
};

/** The inverse edge operations a `task_create`/`task_update` input requests (`addBlocks`/`removeBlocks`). */
export function inverseEdgeOps(input: Record<string, unknown>): InverseEdgeOp[] {
  return [
    ...strArr(input.addBlocks).map((targetId): InverseEdgeOp => ({ targetId, op: 'add' })),
    ...strArr(input.removeBlocks).map((targetId): InverseEdgeOp => ({ targetId, op: 'remove' })),
  ];
}

/** Apply one inverse edge to a target row's current `blocked_by`: append (deduped) or remove `sourceId`. */
export function applyEdge(prev: string[], sourceId: string, op: 'add' | 'remove'): string[] {
  const base = prev.filter(isStr);
  return op === 'add' ? [...new Set([...base, sourceId])] : base.filter((b) => b !== sourceId);
}
