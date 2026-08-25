/** Lines of tool result shown before `… +N lines`. */
export const TOOL_OUTPUT_LINES = 4;

/** Rows of the LIVE thinking tail kept on screen while the agent reasons. */
export const THINKING_TAIL_LINES = 10;

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
    // No key named here. `ctrl+r` used to be, and is bound NOWHERE — a hint that names a dead key is
    // worse than no hint, because the reader presses it and concludes the block cannot open. The
    // affordances are `x` / `X` (advertised in the keymap) and clicking the block itself.
    notice: `… +${hidden} line${hidden === 1 ? '' : 's'}`,
  };
}

/**
 * `truncate` from the other end: the LAST `limit` items, counting what fell off the top.
 *
 * Exists for text that is still being written. Cutting the head off a finished block hides the
 * conclusion, which is why `truncate` keeps the front — but while a stream runs the newest row is
 * the only one worth a screen row, and the front is what the reader has already read.
 */
export function tail<T>(items: T[], limit: number): Truncated<T> {
  if (items.length <= limit) return { shown: items, hidden: 0, notice: null };
  const hidden = items.length - limit;
  return {
    shown: items.slice(items.length - limit),
    hidden,
    notice: `… +${hidden} line${hidden === 1 ? '' : 's'} above`,
  };
}

/**
 * Word-wrapped to `width`, never clipped.
 *
 * The rule this exists to draw: **prose wraps, tables clip.** A tool's output and an error message
 * are prose — `File does not exist. Note: your current working directory is /Users/dennis/Dev…`
 * throws away the half of the sentence that says what to do about it — while a row of a tool group is
 * a table cell, and a wrapped cell stops being a column. So `fitColumn` clips and this does not.
 */
export function wrapWords(text: string, width: number): string[] {
  // Below this there is no wrapping worth doing and a hard split would produce a column of two-letter
  // fragments, so the caller gets one clipped line and can decide it was a bad idea.
  if (width < 8) return [text.slice(0, Math.max(1, width))];

  const rows: string[] = [];
  let line = '';
  const flush = (): void => {
    if (line.length > 0) rows.push(line);
    line = '';
  };

  for (const word of text.split(/\s+/).filter((part) => part.length > 0)) {
    let rest = word;
    // A word wider than the band has no break point in it. Hard-split rather than clip — this is the
    // case every absolute path and every URL hits, and they are exactly the words worth reading.
    while (rest.length > width) {
      flush();
      rows.push(rest.slice(0, width));
      rest = rest.slice(width);
    }
    if (line.length === 0) line = rest;
    else if (line.length + 1 + rest.length <= width) line += ` ${rest}`;
    else {
      flush();
      line = rest;
    }
  }
  flush();
  // A blank source line is a blank rendered line, not nothing: it is a paragraph break in the output.
  return rows.length > 0 ? rows : [''];
}

/**
 * The same wrap as `wrapWords`, reported as OFFSETS into the original string.
 *
 * Exists for syntax-highlighted text. A highlight pass returns coloured chunks over one line, so
 * wrapping it means cutting those chunks at the row boundaries — which needs positions, not the words
 * `wrapWords` hands back. It also preserves whitespace exactly, because a wrapped shell command whose
 * runs of spaces had been collapsed would no longer be the command that ran.
 */
export function wrapRanges(
  text: string,
  width: number,
): { start: number; end: number }[] {
  if (width < 8 || text.length <= width) return [{ start: 0, end: text.length }];

  const ranges: { start: number; end: number }[] = [];
  let start = 0;
  while (start < text.length) {
    if (text.length - start <= width) {
      ranges.push({ start, end: text.length });
      break;
    }
    const hard = start + width;
    // Back off to the last space inside the row. None means one unbroken word — a path or a URL — and
    // those break mid-word rather than run off the edge.
    let space = -1;
    for (let at = hard; at > start; at -= 1) {
      if (text[at] === ' ') {
        space = at;
        break;
      }
    }
    const end = space > start ? space : hard;
    ranges.push({ start, end });
    // The space is consumed by the break; a hard cut keeps every character.
    start = space > start ? space + 1 : hard;
  }
  return ranges;
}

/** The standard rough English ratio. The `~` in the summary owns the imprecision. */
const CHARS_PER_TOKEN = 4;

/**
 * `✻ Thinking… (~1.2K tokens)` — see `truncate` for why no key is named.
 *
 * Sized in tokens, not lines, because a model writes reasoning as a handful of enormous lines: five
 * paragraph-lines and five terse ones both said "5 lines" while one of them was a page and the other
 * a sentence, so the number moved with the model's newline habits instead of with how much there was
 * to read. Tokens are also the unit every other number in this UI is in — the working line, the
 * context meter — and they are ESTIMATED here: a thinking block carries no usage of its own (usage is
 * reported per turn), so counting characters is the only honest measure available at draw time.
 */
export function thinkingSummary(text: string): string {
  const body = text.trim();
  // Nothing to size. Rare, but `(~0 tokens)` reads like a bug rather than like an empty block.
  if (body.length === 0) return 'Thinking…';
  const tokens = body.length / CHARS_PER_TOKEN;
  // Rounded to 10 below 1K: `~318` claims a precision an estimate does not have.
  const count =
    tokens >= 1_000 ? `${(tokens / 1_000).toFixed(1)}K` : `${Math.max(10, Math.round(tokens / 10) * 10)}`;
  return `Thinking… (~${count} tokens)`;
}

/** Ink wraps the live tail too, but the caret needs to land on the last line. */
export function lastLine(text: string): string {
  const index = text.lastIndexOf('\n');
  return index === -1 ? text : text.slice(index + 1);
}
