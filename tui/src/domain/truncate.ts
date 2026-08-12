/** Lines of tool result shown before `… +N lines`. */
export const TOOL_OUTPUT_LINES = 4;

/** Lines of a thinking block shown once the turn has moved past it. */
export const THINKING_COLLAPSED_LINES = 0;

/**
 * Rows of a diff shown before it folds.
 *
 * Larger than `TOOL_OUTPUT_LINES` because a diff's lines are not interchangeable the way a
 * command's output lines are: four lines of a build log is a sample, four lines of a patch is
 * usually the context and the first removal — the edit itself falls below the fold. Eight covers
 * the ordinary two-or-three-line change with its surrounding context and still stops a rewritten
 * file from taking the screen.
 */
export const DIFF_COLLAPSED_LINES = 8;

export type Truncated<T> = {
  shown: T[];
  hidden: number;
  notice: string | null;
};

/** Generic over the item because a diff folds by ROW, and a row is not a string until it is drawn. */
export function truncate<T>(items: T[], limit = TOOL_OUTPUT_LINES): Truncated<T> {
  if (items.length <= limit) return { shown: items, hidden: 0, notice: null };
  const hidden = items.length - limit;
  return {
    shown: items.slice(0, limit),
    hidden,
    notice: `… +${hidden} line${hidden === 1 ? '' : 's'} (ctrl+r to expand)`,
  };
}

/** `✻ Thinking… (18 lines · ctrl+r to expand)`. */
export function thinkingSummary(text: string): string {
  const lines = text.split('\n').filter((l) => l.trim().length > 0).length;
  return `Thinking… (${lines} line${lines === 1 ? '' : 's'} · ctrl+r to expand)`;
}

/** Ink wraps the live tail too, but the caret needs to land on the last line. */
export function lastLine(text: string): string {
  const index = text.lastIndexOf('\n');
  return index === -1 ? text : text.slice(index + 1);
}
