/**
 * Where the columns of a tool-block patch fall, as arithmetic rather than as JSX.
 *
 * `tool-diff.ts` decides WHAT a row says; this decides where it sits. The split matters because the
 * row is drawn as two columns carrying two different signals — a saturated block behind the line
 * number for which side the row is on, and the code itself, syntax-highlighted, in the band to its
 * right. Both of those depend on measurements taken across the whole block (the widest line number,
 * the longest line shown), so the arithmetic has to happen once above the rows rather than once per
 * row, and it should be checkable without a terminal.
 */

import { type DiffRow, diffSign, gutterWidth } from './tool-diff.js';

/** Left of the gutter: the same five columns every other line of tool detail is indented by. */
export const DIFF_INDENT = '     ';

/** The block is `<number> <sign>` — the number's own width plus a space plus the sign. */
export const DIFF_SIGN_COLUMNS = 2;

/** One plain column between the block and the code, so the two never touch. */
export const DIFF_SEPARATOR = ' ';

/** Below this there is no room for a diff worth reading, so it does not try. */
const MIN_BAND = 16;

export type DiffLayout = {
  /** Width of the line-number field inside the block, so the code column does not step in and out. */
  numbers: number;
  /** Columns the code itself gets: what a row is clipped to, and padded to if a theme tints it. */
  columns: number;
};

/**
 * The block's measurements, taken from ALL rows but sized to the ones being SHOWN.
 *
 * Two different row sets on purpose. The number field is measured against every row so that
 * expanding a collapsed diff does not shift the code column sideways — the gutter has to mean the
 * same thing before and after. The code band is measured against the shown rows only, because
 * padding to a line the reader cannot see would be padding to nothing.
 */
export function diffLayout(args: {
  rows: readonly DiffRow[];
  shown: readonly DiffRow[];
  width: number;
}): DiffLayout {
  const numbers = gutterWidth([...args.rows]);
  const band = Math.max(
    MIN_BAND,
    args.width -
      DIFF_INDENT.length -
      numbers -
      DIFF_SIGN_COLUMNS -
      DIFF_SEPARATOR.length,
  );
  // `Math.max()` of nothing is -Infinity, and an empty shown set is reachable through `truncate`
  // with a zero limit. Clamp at zero: a band of no columns draws nothing, which is correct.
  const longest = args.shown.reduce((max, row) => Math.max(max, row.text.length), 0);
  return { numbers, columns: Math.min(band, longest) };
}

/**
 * The block's text: the line number right-aligned, then the sign.
 *
 * The sign lives HERE rather than in front of the code, which is half of why this module exists.
 * Keeping it out of the content column leaves that column a verbatim file line — indentation reads
 * true, and a syntax highlighter can be handed the row without first being told to skip a prefix.
 */
export function diffGutterText(row: DiffRow, numbers: number): string {
  const number = (row.lineNo === null ? '' : String(row.lineNo)).padStart(numbers);
  return `${number} ${diffSign(row.kind)}`;
}

/**
 * Pad to the band, clip to it always.
 *
 * Padding is only ever visible where a theme has set a content background, and neither shipped
 * theme does — the tool block spends its background on the gutter instead. It stays available
 * because a theme may disagree, and an unpadded tint reads as a smear that stops where the text
 * does rather than as a band across the block.
 */
export function fitDiffText(args: {
  text: string;
  columns: number;
  padded: boolean;
}): string {
  if (args.text.length > args.columns) {
    return `${args.text.slice(0, Math.max(0, args.columns - 1))}…`;
  }
  return args.padded ? args.text.padEnd(args.columns) : args.text;
}
