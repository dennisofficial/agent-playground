import { describe, expect, it } from 'bun:test';
import {
  diffRows,
  diffStat,
  diffSummary,
  EDiffLineKind,
  gutterWidth,
  isFileEditTool,
  parseHunks,
  toolDiff,
} from '../tool-diff.js';

/** Shaped exactly like a real `tool_use_result` off the tape — see `raw.jsonl` for the original. */
const updateResult = {
  filePath: '/repo/src/domain/paths.ts',
  oldString: 'old',
  newString: 'new',
  structuredPatch: [
    {
      oldStart: 47,
      oldLines: 3,
      newStart: 47,
      newLines: 4,
      lines: [' }', '-  return old;', '+  return next;', '+  // why', ' '],
    },
  ],
  userModified: false,
};

describe('toolDiff', () => {
  it('takes the engine’s own patch, line numbers and all', () => {
    const hunks = toolDiff({ name: 'Edit', raw: updateResult });
    expect(hunks).toEqual([
      {
        oldStart: 47,
        newStart: 47,
        lines: [' }', '-  return old;', '+  return next;', '+  // why', ' '],
      },
    ]);
  });

  it('writes a created file out as additions — the SDK sends content, not a patch', () => {
    const hunks = toolDiff({
      name: 'Write',
      raw: { type: 'create', content: 'a\nb\n', structuredPatch: [] },
    });
    expect(hunks).toEqual([{ oldStart: 0, newStart: 1, lines: ['+a', '+b'] }]);
  });

  it('leaves tools that do not touch files alone', () => {
    expect(toolDiff({ name: 'Bash', raw: { content: 'a\nb' } })).toEqual([]);
  });

  it('costs the diff, not the transcript, when the SDK’s shape is unrecognisable', () => {
    expect(toolDiff({ name: 'Edit', raw: { structuredPatch: 'nope' } })).toEqual([]);
    expect(toolDiff({ name: 'Edit', raw: undefined })).toEqual([]);
    expect(parseHunks([{ oldStart: 'x', newStart: 1, lines: ['+a'] }])).toEqual([]);
  });

  it('knows which tools change a file', () => {
    expect(isFileEditTool('MultiEdit')).toBe(true);
    expect(isFileEditTool('Read')).toBe(false);
  });
});

describe('diffRows', () => {
  it('numbers each line in the file it belongs to', () => {
    expect(diffRows(toolDiff({ name: 'Edit', raw: updateResult }))).toEqual([
      { kind: EDiffLineKind.context, lineNo: 47, text: '}' },
      { kind: EDiffLineKind.removed, lineNo: 48, text: '  return old;' },
      { kind: EDiffLineKind.added, lineNo: 48, text: '  return next;' },
      { kind: EDiffLineKind.added, lineNo: 49, text: '  // why' },
      { kind: EDiffLineKind.context, lineNo: 50, text: '' },
    ]);
  });

  it('marks the stretch between two hunks rather than butting them together', () => {
    const rows = diffRows([
      { oldStart: 1, newStart: 1, lines: ['+a'] },
      { oldStart: 90, newStart: 91, lines: ['+b'] },
    ]);
    expect(rows.map((r) => r.kind)).toEqual([
      EDiffLineKind.added,
      EDiffLineKind.gap,
      EDiffLineKind.added,
    ]);
    expect(rows[2]?.lineNo).toBe(91);
  });

  it('drops the no-newline marker, which is a note about the patch', () => {
    expect(diffRows([{ oldStart: 1, newStart: 1, lines: ['+a', '\\ No newline at end of file'] }])).toEqual(
      [{ kind: EDiffLineKind.added, lineNo: 1, text: 'a' }],
    );
  });

  it('sizes the gutter to the widest number in the block', () => {
    expect(gutterWidth(diffRows([{ oldStart: 998, newStart: 998, lines: ['+a', '+b', '+c'] }]))).toBe(4);
    expect(gutterWidth([])).toBe(1);
  });
});

describe('diffSummary', () => {
  it.each([
    [{ additions: 6, removals: 1 }, 'Updated with 6 additions and 1 removal'],
    [{ additions: 1, removals: 0 }, 'Updated with 1 addition'],
    [{ additions: 0, removals: 3 }, 'Updated with 3 removals'],
  ])('%o reads as %s', (stat, expected) => {
    expect(diffSummary(stat)).toBe(expected);
  });

  it('counts what the hunks actually did', () => {
    expect(diffStat(toolDiff({ name: 'Edit', raw: updateResult }))).toEqual({
      additions: 2,
      removals: 1,
    });
  });
});
