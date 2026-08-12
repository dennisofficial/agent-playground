import { describe, expect, it } from 'bun:test';
import {
  TOOL_OUTPUT_LINES,
  lastLine,
  thinkingSummary,
  truncate,
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
    expect(result.notice).toBe('… +3 lines (ctrl+r to expand)');
  });

  it('does not pluralise a single hidden line', () => {
    const lines = Array.from({ length: TOOL_OUTPUT_LINES + 1 }, (_, i) => `line ${i}`);
    expect(truncate(lines).notice).toBe('… +1 line (ctrl+r to expand)');
  });

  it('honours a caller-supplied limit', () => {
    expect(truncate(['a', 'b', 'c'], 1).shown).toEqual(['a']);
  });
});

describe('thinkingSummary', () => {
  it('counts only the lines that carry something', () => {
    expect(thinkingSummary('one\n\n   \ntwo')).toBe('Thinking… (2 lines · ctrl+r to expand)');
  });

  it('does not pluralise a single line', () => {
    expect(thinkingSummary('just this')).toBe('Thinking… (1 line · ctrl+r to expand)');
  });

  it('says zero rather than crash on empty thinking', () => {
    expect(thinkingSummary('')).toBe('Thinking… (0 lines · ctrl+r to expand)');
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
