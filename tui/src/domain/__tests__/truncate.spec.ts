import { describe, expect, it } from 'bun:test';
import {
  TOOL_OUTPUT_LINES,
  lastLine,
  tail,
  thinkingSummary,
  truncate,
  wrapRanges,
  wrapWords,
} from '../truncate.js';

describe('truncate', () => {
  it('leaves output that already fits completely alone', () => {
    const lines = ['a', 'b'];
    expect(truncate(lines)).toEqual({ shown: lines, hidden: 0, notice: null });
  });

  it('keeps the boundary case whole — exactly at the limit is not truncation', () => {
    const lines = Array.from({ length: TOOL_OUTPUT_LINES }, (_, i) => `line ${i}`);
    expect(truncate(lines).notice).toBeNull();
  });

  it('cuts to the limit and counts what it hid', () => {
    const lines = Array.from({ length: TOOL_OUTPUT_LINES + 3 }, (_, i) => `line ${i}`);
    const result = truncate(lines);
    expect(result.shown).toHaveLength(TOOL_OUTPUT_LINES);
    expect(result.hidden).toBe(3);
    expect(result.notice).toBe('… +3 lines');
  });

  it('does not pluralise a single hidden line', () => {
    const lines = Array.from({ length: TOOL_OUTPUT_LINES + 1 }, (_, i) => `line ${i}`);
    expect(truncate(lines).notice).toBe('… +1 line');
  });

  it('honours a caller-supplied limit', () => {
    expect(truncate(['a', 'b', 'c'], 1).shown).toEqual(['a']);
  });
});

describe('tail', () => {
  it('leaves a list that already fits completely alone', () => {
    const lines = ['a', 'b'];
    expect(tail(lines, 4)).toEqual({ shown: lines, hidden: 0, notice: null });
  });

  it('keeps the boundary case whole — exactly at the limit is not truncation', () => {
    expect(tail(['a', 'b'], 2).notice).toBeNull();
  });

  it('keeps the END, unlike truncate, and counts what fell off the top', () => {
    const result = tail(['a', 'b', 'c', 'd'], 2);
    expect(result.shown).toEqual(['c', 'd']);
    expect(result.hidden).toBe(2);
    expect(result.notice).toBe('… +2 lines above');
  });

  it('does not pluralise a single hidden line', () => {
    expect(tail(['a', 'b'], 1).notice).toBe('… +1 line above');
  });
});

describe('thinkingSummary', () => {
  it('sizes by content, not by newlines — one long line is not "1 line"', () => {
    expect(thinkingSummary('x'.repeat(1_200))).toBe('Thinking… (~300 tokens)');
  });

  it('does not let line COUNT move the number — same text, different wrapping', () => {
    const words = Array.from({ length: 100 }, () => 'token').join(' ');
    expect(thinkingSummary(words)).toBe(thinkingSummary(words.replace(/ /g, '\n')));
  });

  it('rounds to 10 below 1K rather than claim single-token precision', () => {
    expect(thinkingSummary('x'.repeat(318))).toBe('Thinking… (~80 tokens)');
  });

  it('never rounds a short block down to nothing', () => {
    expect(thinkingSummary('brief')).toBe('Thinking… (~10 tokens)');
  });

  it('switches to K past a thousand', () => {
    expect(thinkingSummary('x'.repeat(9_600))).toBe('Thinking… (~2.4K tokens)');
  });

  it('says nothing rather than "~0 tokens" on empty thinking', () => {
    expect(thinkingSummary('')).toBe('Thinking…');
  });
});

describe('lastLine', () => {
  it('is the whole string when nothing wrapped', () => {
    expect(lastLine('abc')).toBe('abc');
  });

  it('is the text after the final newline — where the caret has to land', () => {
    expect(lastLine('a\nb\nc')).toBe('c');
  });

  it('is empty when the text ends on a newline, not the line before it', () => {
    expect(lastLine('a\n')).toBe('');
  });
});

describe('wrapWords', () => {
  it('fills greedily and breaks on whitespace', () => {
    expect(wrapWords('one two three four five', 12)).toEqual(['one two', 'three four', 'five']);
  });

  it('hard-splits a word wider than the band rather than clipping it', () => {
    // The case every absolute path hits. Clipping here would throw away the part that names the file.
    expect(wrapWords('/Users/dennis/Developer/atlas/tui/src/domain/tool-view.ts', 20)).toEqual([
      '/Users/dennis/Develo',
      'per/atlas/tui/src/do',
      'main/tool-view.ts',
    ]);
  });

  it('keeps a short word on the line a long one just ended', () => {
    expect(wrapWords('aaaaaaaaaaaa bb', 10)).toEqual(['aaaaaaaaaa', 'aa bb']);
  });

  it('renders a blank line as a blank line, not as nothing', () => {
    // A blank source line is a paragraph break in a tool's output; dropping it reflows the output.
    expect(wrapWords('', 40)).toEqual(['']);
    expect(wrapWords('   ', 40)).toEqual(['']);
  });

  it('gives up and clips below a band worth wrapping in', () => {
    expect(wrapWords('some prose here', 4)).toEqual(['some']);
    expect(wrapWords('some prose here', 0)).toEqual(['s']);
  });

  it('never returns a row wider than the band', () => {
    const text =
      'File does not exist. Note: your current working directory is /Users/dennis/Developer/atlas.';
    for (const width of [8, 20, 40, 72, 100]) {
      for (const row of wrapWords(text, width)) expect(row.length).toBeLessThanOrEqual(width);
    }
  });
});

describe('wrapRanges', () => {
  const rowsOf = (text: string, width: number) =>
    wrapRanges(text, width).map((r) => text.slice(r.start, r.end));

  it('breaks on spaces and reports offsets into the original string', () => {
    expect(rowsOf('one two three four five', 12)).toEqual(['one two', 'three four', 'five']);
  });

  it('preserves whitespace exactly, unlike wrapWords', () => {
    // A wrapped shell command whose runs of spaces were collapsed is no longer the command that ran.
    const command = 'grep -n  "a  b"   file.ts';
    expect(rowsOf(command, 40)).toEqual([command]);
    expect(rowsOf(command, 12).join(' ')).toContain('"a  b"');
  });

  it('breaks mid-word when a word is wider than the band', () => {
    expect(rowsOf('/Users/dennis/Developer/atlas/tui/src/domain/x.ts', 20)).toEqual([
      '/Users/dennis/Develo',
      'per/atlas/tui/src/do',
      'main/x.ts',
    ]);
  });

  it('loses no character but the space it broke on', () => {
    // Stated over non-whitespace, because that is the invariant that actually holds: a SOFT break
    // consumes one space, a HARD break consumes nothing, and re-joining with a space would invent one
    // in the middle of a path. Nothing else may be dropped, duplicated or reordered.
    const text = 'cd /Users/dennis/.atlas/sessions; echo "=== started ==="; wc -l *.jsonl | head';
    for (const width of [8, 20, 40, 72]) {
      const rows = rowsOf(text, width);
      for (const row of rows) expect(row.length).toBeLessThanOrEqual(width);
      expect(rows.join('').replace(/\s/g, '')).toBe(text.replace(/\s/g, ''));
    }
  });

  it('returns one empty range for empty text', () => {
    expect(wrapRanges('', 40)).toEqual([{ start: 0, end: 0 }]);
  });
});
