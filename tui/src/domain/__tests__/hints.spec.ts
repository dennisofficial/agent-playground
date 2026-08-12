import { describe, expect, it } from 'bun:test';
import { fitHints } from '../hints.js';

const FORMS = ['↑↓ select · ⏎ open · esc back', '⏎ open · esc back', '⏎ open'];

describe('fitHints', () => {
  it('takes the widest form that fits', () => {
    expect(fitHints(80, FORMS)).toBe(FORMS[0]!);
  });

  it('steps down as the terminal narrows', () => {
    expect(fitHints(20, FORMS)).toBe(FORMS[1]!);
    expect(fitHints(10, FORMS)).toBe(FORMS[2]!);
  });

  it('fits a form of exactly the available width, and drops it one column later', () => {
    expect(fitHints(29, FORMS)).toBe(FORMS[0]!); // 29 code points
    expect(fitHints(28, FORMS)).toBe(FORMS[1]!);
  });

  it('measures in code points, not UTF-16 units — an astral glyph is ONE column', () => {
    const astral = '🭬 open'; // 6 code points, 7 UTF-16 units
    expect(fitHints(6, [astral, 'open'])).toBe(astral);
  });

  it('shows the shortest form rather than nothing when even that overflows', () => {
    expect(fitHints(1, FORMS)).toBe(FORMS[2]!);
  });

  it('is empty when there is nothing to show, rather than undefined', () => {
    expect(fitHints(40, [])).toBe('');
  });
});
