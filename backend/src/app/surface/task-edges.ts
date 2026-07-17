
export const isStr = (v: unknown): v is string => typeof v === 'string';

export const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter(isStr) : []);

export function mergeBlockedBy(prev: string[], input: Record<string, unknown>): string[] {
  const remove = new Set(strArr(input.removeBlockedBy));
  return [
    ...new Set([...prev.filter(isStr), ...strArr(input.blockedBy), ...strArr(input.addBlockedBy)]),
  ].filter((b) => !remove.has(b));
}

export function hasBlockedByInput(input: Record<string, unknown>): boolean {
  return (
    input.blockedBy !== undefined ||
    input.addBlockedBy !== undefined ||
    input.removeBlockedBy !== undefined
  );
}

export type InverseEdgeOp = {
  targetId: string;
  op: 'add' | 'remove';
};

export function inverseEdgeOps(input: Record<string, unknown>): InverseEdgeOp[] {
  return [
    ...strArr(input.addBlocks).map((targetId): InverseEdgeOp => ({ targetId, op: 'add' })),
    ...strArr(input.removeBlocks).map((targetId): InverseEdgeOp => ({ targetId, op: 'remove' })),
  ];
}

export function applyEdge(prev: string[], sourceId: string, op: 'add' | 'remove'): string[] {
  const base = prev.filter(isStr);
  return op === 'add' ? [...new Set([...base, sourceId])] : base.filter((b) => b !== sourceId);
}
