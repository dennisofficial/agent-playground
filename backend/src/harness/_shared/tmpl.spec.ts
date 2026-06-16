import { describe, expect, it } from 'vitest';
import { tmpl } from './tmpl';

describe('tmpl', () => {
  it('substitutes named slots in order', () => {
    const t = tmpl`Hello ${'name'}, your role is ${'role'}.`;
    expect(t({ name: 'Alex', role: 'backend' })).toBe(
      'Hello Alex, your role is backend.',
    );
  });

  it('reuses a slot used more than once', () => {
    const t = tmpl`${'name'} — start every report with "${'name'} —".`;
    expect(t({ name: 'Alex' })).toBe(
      'Alex — start every report with "Alex —".',
    );
  });

  it('passes literal braces through verbatim (no f-string parsing)', () => {
    const t = tmpl`Return \`{ summary: ${'value'}, ok: true }\``;
    expect(t({ value: 'x' })).toBe('Return `{ summary: x, ok: true }`');
  });

  it('does NOT trim — preserves exact leading/trailing bytes', () => {
    const t = tmpl`\n\n${'block'}\n\n`;
    expect(t({ block: 'B' })).toBe('\n\nB\n\n');
  });

  it('renders a no-slot template as the literal string', () => {
    const t = tmpl`just text`;
    expect(t({})).toBe('just text');
  });
});
