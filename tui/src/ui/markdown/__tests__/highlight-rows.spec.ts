import { describe, expect, it } from 'bun:test';
import type { TextChunk } from '@opentui/core';
import { registerGrammars } from '../grammars/index.js';
import { chunksByLine, fitDiffChunks, highlightRows } from '../highlight-rows.js';

/**
 * The two halves of turning a highlight pass into diff rows: cutting one flat run of chunks into
 * lines, and clipping a line to the band. Both are pure; the pass itself is exercised at the end
 * because the thing worth proving about it is that a FRAGMENT — which is all a hunk ever is — comes
 * back with real captures rather than nothing.
 */

// Grammars must be registered before any client takes the default parser set.
await registerGrammars();

function chunk(text: string, fg?: string): TextChunk {
  return { __isChunk: true, text, ...(fg ? { fg: fg as unknown as TextChunk['fg'] } : {}) };
}

function textOf(rows: readonly (readonly TextChunk[])[]): string[] {
  return rows.map((row) => row.map((c) => c.text).join(''));
}

describe('chunksByLine', () => {
  it('cuts a run that spans lines without losing or duplicating a character', () => {
    const rows = chunksByLine([chunk('const a = 1;\nconst b = 2;')], 2);
    expect(textOf(rows)).toEqual(['const a = 1;', 'const b = 2;']);
  });

  it('keeps several chunks on one line, in order, with their styles', () => {
    const rows = chunksByLine(
      [chunk('const', '#f00'), chunk(' a = '), chunk('1', '#0f0'), chunk(';\nnext')],
      2,
    );
    expect(textOf(rows)).toEqual(['const a = 1;', 'next']);
    expect(rows[0]?.length).toBe(4);
    expect(rows[0]?.[0]?.fg).toBe('#f00' as unknown as TextChunk['fg']);
    expect(rows[0]?.[2]?.fg).toBe('#0f0' as unknown as TextChunk['fg']);
  });

  it('gives an empty line an empty row rather than swallowing it', () => {
    // A blank context line is ordinary in a hunk, and dropping it would slide every row below it up
    // one — the code would stop lining up with the numbers beside it.
    const rows = chunksByLine([chunk('a\n\nb')], 3);
    expect(textOf(rows)).toEqual(['a', '', 'b']);
  });

  it('always returns exactly one row per line, even if the chunks run short or long', () => {
    expect(chunksByLine([chunk('a')], 3)).toHaveLength(3);
    expect(chunksByLine([chunk('a\nb\nc\nd')], 2)).toHaveLength(2);
  });
});

describe('fitDiffChunks', () => {
  it('leaves a row that fits completely alone', () => {
    const chunks = [chunk('const'), chunk(' a')];
    expect(fitDiffChunks({ chunks, columns: 20 })).toBe(chunks);
  });

  it('clips across chunk boundaries and lands exactly on the band', () => {
    const fitted = fitDiffChunks({
      chunks: [chunk('const'), chunk(' a = '), chunk('1234567890')],
      columns: 10,
    });
    const text = fitted.map((c) => c.text).join('');
    expect(text).toBe('const a =…');
    expect(text.length).toBe(10);
  });

  it('gives the ellipsis the colour of the chunk it cut, not one of its own', () => {
    const fitted = fitDiffChunks({ chunks: [chunk('abcdefgh', '#f00')], columns: 4 });
    expect(fitted.at(-1)?.text).toBe('…');
    expect(fitted.at(-1)?.fg).toBe('#f00' as unknown as TextChunk['fg']);
  });
});

describe('highlightRows', () => {
  it('highlights a mid-file fragment, which is all a hunk ever is', async () => {
    // Unbalanced on purpose: this starts inside a function body and never closes it. Tree-sitter's
    // error recovery is what makes highlighting a hunk viable at all, so it is asserted rather than
    // assumed.
    const rows = await highlightRows({
      lines: ['  const parsed = JSON.parse(raw);', '  if (!parsed.name) throw new Error("no");'],
      filetype: 'typescript',
    });
    expect(rows).not.toBeNull();
    expect(rows).toHaveLength(2);
    expect(textOf(rows ?? [])).toEqual([
      '  const parsed = JSON.parse(raw);',
      '  if (!parsed.name) throw new Error("no");',
    ]);
    // Several distinct colours, or it parsed but captured nothing worth drawing.
    const colours = new Set((rows ?? []).flat().map((c) => String(c.fg)));
    expect(colours.size).toBeGreaterThan(2);
  });

  it('returns null for a filetype with no grammar, so the caller keeps its plain text', async () => {
    expect(await highlightRows({ lines: ['fn main() {}'], filetype: 'nonesuch' })).toBeNull();
  });

  it('reproduces the row text byte for byte, so the code stays aligned with its gutter', async () => {
    // Concealment is the hazard: left on, it DELETES characters, and a row one character short
    // stops lining up with the number beside it.
    const lines = ['const s = "a\\nb";', '/** doc */', ''];
    const rows = await highlightRows({ lines, filetype: 'typescript' });
    expect(textOf(rows ?? [])).toEqual(lines);
  });
});
