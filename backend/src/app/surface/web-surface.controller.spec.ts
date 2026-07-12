import { describe, expect, it } from 'vitest';
import { formatReviewComments, mapMessageSource } from './web-surface.controller';

/**
 * `formatReviewComments` is what actually drives Atlas's turn (the `review_comments_card` persisted
 * alongside it is render-only) — a grouping/formatting bug here would silently feed the agent malformed
 * or dropped review input, so it's worth a dedicated pure-function test.
 */
describe('formatReviewComments', () => {
  it('groups multiple comments in the same file under one header', () => {
    const text = formatReviewComments([
      { file: 'plan.md', quote: 'first quote', note: 'first note' },
      { file: 'plan.md', quote: 'second quote' },
    ]);
    expect(text).toContain('2 review comments');
    expect((text.match(/\*\*plan\.md\*\*/g) ?? []).length).toBe(1);
    expect(text).toContain('> "first quote"');
    expect(text).toContain('— first note');
    expect(text).toContain('> "second quote"');
  });

  it('groups comments across multiple files under separate headers, in first-seen order', () => {
    const text = formatReviewComments([
      { file: 'plan.md', quote: 'a' },
      { file: '02-engine.md', quote: 'b' },
      { file: 'plan.md', quote: 'c' },
    ]);
    const planIdx = text.indexOf('**plan.md**');
    const engineIdx = text.indexOf('**02-engine.md**');
    expect(planIdx).toBeGreaterThan(-1);
    expect(engineIdx).toBeGreaterThan(planIdx);
    expect(text).toContain('> "a"');
    expect(text).toContain('> "b"');
    expect(text).toContain('> "c"');
  });

  it('omits the note line for a comment with no note', () => {
    const text = formatReviewComments([{ file: 'plan.md', quote: 'quote only' }]);
    expect(text).toContain('> "quote only"');
    expect(text).not.toContain('—');
  });

  it('appends the operator prose message at the end when present', () => {
    const text = formatReviewComments(
      [{ file: 'plan.md', quote: 'q' }],
      'please also double-check the retry logic',
    );
    expect(text.trim().endsWith('please also double-check the retry logic')).toBe(true);
  });

  it('trims a whitespace-only message to nothing', () => {
    const text = formatReviewComments([{ file: 'plan.md', quote: 'q' }], '   ');
    expect(text.trim().endsWith('"q"')).toBe(true);
  });

  it('singularizes the count line for exactly one comment', () => {
    const text = formatReviewComments([{ file: 'plan.md', quote: 'q' }]);
    expect(text).toContain('1 review comment:');
  });

  it('renders a line-anchored item GitHub-style instead of a blockquote', () => {
    const text = formatReviewComments([
      {
        file: 'step-view.tsx',
        quote: '<code>',
        note: 'rename this',
        lines: { path: 'web/src/features/job-workspace/step-view.tsx', side: 'new', start: 820, end: 822 },
      },
    ]);
    expect(text).toContain('`web/src/features/job-workspace/step-view.tsx:820-822`');
    expect(text).toContain('(new)');
    expect(text).toContain('```\n<code>\n```');
    expect(text).toContain('— rename this');
    expect(text).not.toContain('> "<code>"');
  });
});

describe('mapMessageSource', () => {
  it('passes the explicit system_* provenance tags through, ignoring isAtlas', () => {
    expect(mapMessageSource('system_operator', false)).toBe('system_operator');
    expect(mapMessageSource('system_shared', true)).toBe('system_shared');
    expect(mapMessageSource('system_event', false)).toBe('system_event');
    expect(mapMessageSource('system_notice', true)).toBe('system_notice');
    expect(mapMessageSource('system_reminder', false)).toBe('system_reminder');
  });

  it('falls back to atlas/operator by isAtlas when no source is stamped (older rows)', () => {
    expect(mapMessageSource(undefined, true)).toBe('atlas');
    expect(mapMessageSource(undefined, false)).toBe('operator');
    expect(mapMessageSource(null, true)).toBe('atlas');
    expect(mapMessageSource('anything-unknown', false)).toBe('operator');
  });
});
