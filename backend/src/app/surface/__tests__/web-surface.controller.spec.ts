import { describe, expect, it } from 'vitest';
import { formatReviewComments, mapMessageSource } from '../web-surface.controller';

/**
 * `formatReviewComments` is what actually drives Atlas's turn (the `review_comments_card` persisted
 * alongside it is render-only) — a grouping/formatting bug here would silently feed the agent malformed
 * or dropped review input, so it's worth a dedicated pure-function test.
 */
describe('formatReviewComments', () => {
  it('wraps the batch in <review-comments count> with one <comment> per item', () => {
    const text = formatReviewComments([
      { file: 'plan.md', quote: 'first quote', note: 'first note' },
      { file: 'plan.md', quote: 'second quote' },
    ]);
    expect(text.startsWith('<review-comments count="2">')).toBe(true);
    expect(text.trimEnd().endsWith('</review-comments>')).toBe(true);
    expect((text.match(/<comment /g) ?? []).length).toBe(2);
    expect(text).toContain('<quote>first quote</quote>');
    expect(text).toContain('<note>first note</note>');
    expect(text).toContain('<quote>second quote</quote>');
  });

  it('emits comments in first-seen order (flat, not grouped by file)', () => {
    const text = formatReviewComments([
      { file: 'plan.md', quote: 'a' },
      { file: '02-engine.md', quote: 'b' },
    ]);
    expect(text.indexOf('<quote>a</quote>')).toBeLessThan(text.indexOf('<quote>b</quote>'));
  });

  it('omits the <note> element for a comment with no note', () => {
    const text = formatReviewComments([{ file: 'plan.md', quote: 'quote only' }]);
    expect(text).toContain('<quote>quote only</quote>');
    expect(text).not.toContain('<note>');
  });

  it('appends the operator prose in a trailing <message>', () => {
    const text = formatReviewComments(
      [{ file: 'plan.md', quote: 'q' }],
      'please also double-check the retry logic',
    );
    expect(text).toContain('<message>please also double-check the retry logic</message>');
  });

  it('omits <message> for a whitespace-only message', () => {
    const text = formatReviewComments([{ file: 'plan.md', quote: 'q' }], '   ');
    expect(text).not.toContain('<message>');
  });

  it('renders a diff line-anchor with both spans + a signed ```diff fragment', () => {
    const text = formatReviewComments([
      {
        file: 'csv-export.ts',
        quote: '- old\n+ new',
        note: 'use the helper & keep <T> generic',
        lines: {
          path: 'src/csv-export.ts',
          oldStart: 3,
          oldEnd: 3,
          newStart: 10,
          newEnd: 10,
          fragment:
            '- const lines = [headers.join(",")];\n+ const lines = [headers.map(escapeCell).join(",")];',
        },
      },
    ]);
    expect(text).toContain('<comment file="src/csv-export.ts" old-lines="3" new-lines="10">');
    expect(text).toContain('```diff');
    expect(text).toContain('- const lines = [headers.join(",")];');
    expect(text).toContain('+ const lines = [headers.map(escapeCell).join(",")];');
    // note is XML-escaped
    expect(text).toContain('<note>use the helper &amp; keep &lt;T&gt; generic</note>');
    expect(text).not.toContain('<quote>');
  });

  it('emits only the present span for a pure-deletion anchor', () => {
    const text = formatReviewComments([
      {
        file: 'a.ts',
        quote: '- gone',
        lines: {
          path: 'src/a.ts',
          oldStart: 20,
          oldEnd: 21,
          fragment: '- gone();\n- also();',
        },
      },
    ]);
    expect(text).toContain('old-lines="20-21"');
    expect(text).not.toContain('new-lines=');
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
