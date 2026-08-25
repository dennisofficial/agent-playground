import { describe, expect, it } from 'bun:test';
import {
  DIFF_INDENT,
  DIFF_SEPARATOR,
  DIFF_SIGN_COLUMNS,
  diffGutterText,
  diffLayout,
  fitDiffText,
} from '../diff-layout.js';
import { type DiffRow, EDiffLineKind } from '../tool-diff.js';

function row(kind: EDiffLineKind, lineNo: number | null, text: string): DiffRow {
  return { kind, lineNo, text };
}

const ROWS: DiffRow[] = [
  row(EDiffLineKind.context, 8, 'const a = 1;'),
  row(EDiffLineKind.removed, 9, '  return old;'),
  row(EDiffLineKind.added, 9, '  return neww;'),
  row(EDiffLineKind.gap, null, ''),
  row(EDiffLineKind.context, 120, '}'),
];

describe('diffGutterText', () => {
  it('puts the sign after a right-aligned number, so code starts at a fixed column', () => {
    expect(diffGutterText(ROWS[0]!, 3)).toBe('  8  ');
    expect(diffGutterText(ROWS[1]!, 3)).toBe('  9 -');
    expect(diffGutterText(ROWS[2]!, 3)).toBe('  9 +');
  });

  it('draws a gap as blanks, not as a number it does not have', () => {
    expect(diffGutterText(ROWS[3]!, 3)).toBe('     ');
    // Trailing blanks are why this is not `.toBe('    ')` by accident: width is number + space +
    // sign, and every row must produce the same width or the code column steps sideways.
    const widths = ROWS.map((r) => diffGutterText(r, 3).length);
    expect(new Set(widths).size).toBe(1);
  });
});

describe('diffLayout', () => {
  it('sizes the number field to the widest line in the WHOLE diff, not the shown part', () => {
    // `120` is the widest number and it lives past the fold. Measuring only the shown rows would
    // shift the code column sideways on expand, and the gutter has to mean the same thing in both.
    const collapsed = diffLayout({ rows: ROWS, shown: ROWS.slice(0, 2), width: 80 });
    const expanded = diffLayout({ rows: ROWS, shown: ROWS, width: 80 });
    expect(collapsed.numbers).toBe(3);
    expect(expanded.numbers).toBe(3);
  });

  it('sizes the code band to the longest line SHOWN', () => {
    const { columns } = diffLayout({ rows: ROWS, shown: ROWS, width: 80 });
    expect(columns).toBe('  return neww;'.length);
  });

  it('leaves room for indent, block and separator, and never overflows the width', () => {
    const wide = ROWS.map((r) => ({ ...r, text: 'x'.repeat(200) }));
    const { numbers, columns } = diffLayout({ rows: wide, shown: wide, width: 80 });
    const drawn =
      DIFF_INDENT.length + numbers + DIFF_SIGN_COLUMNS + DIFF_SEPARATOR.length + columns;
    expect(drawn).toBeLessThanOrEqual(80);
  });

  it('keeps a floor of readable columns rather than collapsing in a narrow pane', () => {
    const { columns } = diffLayout({ rows: ROWS, shown: ROWS, width: 4 });
    expect(columns).toBeGreaterThan(0);
  });

  it('survives an empty shown set rather than returning -Infinity', () => {
    expect(diffLayout({ rows: ROWS, shown: [], width: 80 }).columns).toBe(0);
  });
});

describe('fitDiffText', () => {
  it('clips with an ellipsis when a line is wider than the band', () => {
    const fitted = fitDiffText({ text: 'abcdefghij', columns: 5, padded: false });
    expect(fitted).toBe('abcd…');
    expect(fitted.length).toBe(5);
  });

  it('pads only when a theme has set a content background', () => {
    expect(fitDiffText({ text: 'ab', columns: 5, padded: false })).toBe('ab');
    expect(fitDiffText({ text: 'ab', columns: 5, padded: true })).toBe('ab   ');
  });
});
