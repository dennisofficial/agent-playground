import { lineStartIndex, toLines, type EditorState } from "./text-editor.js";

export type ComposerRow = {
  readonly text: string;
  /** Column the caret sits at in this row, or `null` when the caret is elsewhere. */
  readonly caret: number | null;
  /** Offset of this row's first character in the draft — what a click on it resolves against. */
  readonly start: number;
};

export type ComposerLayout = {
  readonly rows: ComposerRow[];
  readonly hiddenAbove: number;
  readonly hiddenBelow: number;
};

export type ComposerViewport = {
  readonly top: number;
  readonly revealCaret: boolean;
};

const CARET_MARGIN = 1;

type Fragment = { text: string; start: number };

export function layoutComposer(
  state: EditorState,
  width: number,
  maxRows: number,
  viewport: ComposerViewport = { top: 0, revealCaret: true },
): ComposerLayout {
  const usableWidth = Math.max(1, width);
  const fragments = wrap(state.text, usableWidth);

  let caretRow = 0;
  let caretColumn = 0;
  for (let index = 0; index < fragments.length; index++) {
    const fragment = fragments[index] as Fragment;
    const end = fragment.start + fragment.text.length;
    if (state.cursor >= fragment.start && state.cursor <= end) {
      caretRow = index;
      caretColumn = state.cursor - fragment.start;
      // On a boundary, keep scanning: a following fragment starting at exactly this index is a
      // continuation of the same logical line, and the caret belongs at its column 0.
      if (state.cursor < end) break;
    }
  }

  // A caret at the end of an exactly-full row has no column left to occupy, so give it one.
  if (caretColumn === usableWidth) {
    fragments.splice(caretRow + 1, 0, { text: "", start: state.cursor });
    caretRow += 1;
    caretColumn = 0;
  }

  const start = windowStart(caretRow, fragments.length, maxRows, viewport);
  const visible = fragments.slice(start, start + maxRows);

  return {
    rows: visible.map((fragment, index) => ({
      text: fragment.text,
      caret: start + index === caretRow ? caretColumn : null,
      start: fragment.start,
    })),
    hiddenAbove: start,
    hiddenBelow: Math.max(0, fragments.length - (start + visible.length)),
  };
}

function wrap(text: string, width: number): Fragment[] {
  const fragments: Fragment[] = [];
  let lineStart = 0;

  for (const line of toLines(text)) {
    let offset = 0;
    do {
      const end = breakPoint(line, offset, width);
      fragments.push({
        text: line.slice(offset, end),
        start: lineStart + offset,
      });
      offset = end;
    } while (offset < line.length);
    lineStart += line.length + 1; // + the newline
  }

  return fragments;
}

function breakPoint(line: string, offset: number, width: number): number {
  const limit = offset + width;
  if (limit >= line.length) return line.length;

  const lastSpace = line.lastIndexOf(" ", limit - 1);
  return lastSpace > offset ? lastSpace + 1 : limit;
}

function windowStart(
  caretRow: number,
  total: number,
  maxRows: number,
  viewport: ComposerViewport,
): number {
  if (total <= maxRows) return 0;

  const last = total - maxRows;
  const parked = clamp(viewport.top, 0, last);
  if (!viewport.revealCaret) return parked;

  const latestStart = caretRow - CARET_MARGIN;
  const earliestStart = caretRow + CARET_MARGIN - (maxRows - 1);

  if (parked > latestStart) return clamp(latestStart, 0, last);
  if (parked < earliestStart) return clamp(earliestStart, 0, last);
  return parked;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

export function indexAt(
  layout: ComposerLayout,
  row: number,
  column: number,
): number {
  const rows = layout.rows;
  if (rows.length === 0) return 0;

  const target = rows[clamp(row, 0, rows.length - 1)] as ComposerRow;
  return target.start + clamp(column, 0, target.text.length);
}

export function caretPosition(state: EditorState): {
  row: number;
  column: number;
} {
  let row = 0;
  for (let index = 0; index < state.cursor; index++) {
    if (state.text[index] === "\n") row++;
  }
  return {
    row,
    column: state.cursor - lineStartIndex(state.text, state.cursor),
  };
}
