import { describe, expect, it } from 'vitest';
import { anchorLabel, deriveLineAnchor } from './diff-anchor';

describe('deriveLineAnchor', () => {
  it('returns null for an empty selection', () => {
    expect(deriveLineAnchor([])).toBeNull();
  });

  it('captures BOTH old and new spans for a mixed add/del/context range + a signed fragment', () => {
    const anchor = deriveLineAnchor([
      { type: 'context', oldNo: 10, newNo: 10, code: 'const a = 1;' },
      { type: 'del', oldNo: 11, code: 'const old = 2;' },
      { type: 'add', newNo: 11, code: 'const b = 2;' },
    ]);
    expect(anchor).toEqual({
      oldStart: 10,
      oldEnd: 11,
      newStart: 10,
      newEnd: 11,
      fragment: '  const a = 1;\n- const old = 2;\n+ const b = 2;',
    });
  });

  it('a pure-deletion range has only an old span', () => {
    const anchor = deriveLineAnchor([
      { type: 'del', oldNo: 20, code: 'gone();' },
      { type: 'del', oldNo: 21, code: 'also_gone();' },
    ]);
    expect(anchor).toEqual({
      oldStart: 20,
      oldEnd: 21,
      fragment: '- gone();\n- also_gone();',
    });
  });

  it('a pure-addition range has only a new span', () => {
    const anchor = deriveLineAnchor([{ type: 'add', newNo: 5, code: 'added();' }]);
    expect(anchor).toEqual({
      newStart: 5,
      newEnd: 5,
      fragment: '+ added();',
    });
  });
});

describe('anchorLabel', () => {
  it('prefers the new-side span', () => {
    expect(anchorLabel({ oldStart: 3, oldEnd: 3, newStart: 10, newEnd: 12 })).toBe('L10–12');
  });

  it('collapses a single-line span', () => {
    expect(anchorLabel({ newStart: 7, newEnd: 7 })).toBe('L7');
  });

  it('falls back to the old span (tagged) for a pure deletion', () => {
    expect(anchorLabel({ oldStart: 20, oldEnd: 21 })).toBe('L20–21 (old)');
  });
});
