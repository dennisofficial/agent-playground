/** Lines of tool result shown before `… +N lines`. */
export const TOOL_OUTPUT_LINES = 4;

/** Lines of a thinking block shown once the turn has moved past it. */
export const THINKING_COLLAPSED_LINES = 0;

export type Truncated = {
  shown: string[];
  hidden: number;
  notice: string | null;
};

export function truncate(lines: string[], limit = TOOL_OUTPUT_LINES): Truncated {
  if (lines.length <= limit) return { shown: lines, hidden: 0, notice: null };
  const hidden = lines.length - limit;
  return {
    shown: lines.slice(0, limit),
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
