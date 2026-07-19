import type { DiffRow } from '../tool-calls/diff-rows';

/**
 * A line-range anchor for a diff comment. A selection can straddle deletions AND additions, so it carries
 * BOTH the old-file span and the new-file span it covers (either may be absent for a pure add/delete), plus
 * the signed diff `fragment` the operator actually selected (`+`/`−`/context lines) — so the comment sent to
 * Atlas shows exactly what was highlighted without forcing it to re-read the file.
 */
export type LineAnchor = {
  oldStart?: number;
  oldEnd?: number;
  newStart?: number;
  newEnd?: number;
  fragment: string;
};

const rowSign = (t: DiffRow['type']): string => (t === 'add' ? '+' : t === 'del' ? '-' : ' ');

/** Derive the old/new spans + signed fragment from a contiguous run of selected diff rows. */
export function deriveLineAnchor(
  rows: Pick<DiffRow, 'type' | 'oldNo' | 'newNo' | 'code'>[],
): LineAnchor | null {
  if (rows.length === 0) return null;
  const oldNos = rows.filter((r) => r.oldNo != null).map((r) => r.oldNo!);
  const newNos = rows.filter((r) => r.newNo != null).map((r) => r.newNo!);
  return {
    ...(oldNos.length ? { oldStart: Math.min(...oldNos), oldEnd: Math.max(...oldNos) } : {}),
    ...(newNos.length ? { newStart: Math.min(...newNos), newEnd: Math.max(...newNos) } : {}),
    fragment: rows.map((r) => `${rowSign(r.type)} ${r.code}`).join('\n'),
  };
}

type Spans = {
  oldStart?: number;
  oldEnd?: number;
  newStart?: number;
  newEnd?: number;
};

/** Short display label for an anchor: the new-side span (what's in the worktree) when present, else old. */
export function anchorLabel(a: Spans): string {
  const span = (s?: number, e?: number, tag = ''): string | null =>
    s == null ? null : `L${s}${e != null && e !== s ? `–${e}` : ''}${tag}`;
  return span(a.newStart, a.newEnd) ?? span(a.oldStart, a.oldEnd, ' (old)') ?? '';
}

/** The (side, line) a comment docks under — the end of its new span, else its old span. */
export function anchorEnd(a: {
  oldEnd?: number;
  newEnd?: number;
}): { side: 'old' | 'new'; line: number } | null {
  if (a.newEnd != null) return { side: 'new', line: a.newEnd };
  if (a.oldEnd != null) return { side: 'old', line: a.oldEnd };
  return null;
}
