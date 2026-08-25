import { describe, expect, it } from 'bun:test';
import { segmentMarkdown } from '../segment.js';

describe('segmentMarkdown', () => {
  it('is empty for empty input', () => {
    expect(segmentMarkdown('')).toEqual([]);
  });

  it('produces exactly one prose segment when there are no fences', () => {
    const source = 'Some *prose* with **emphasis**.';
    const segments = segmentMarkdown(source);
    expect(segments).toEqual([{ kind: 'prose', text: source }]);
  });

  it('produces exactly one fence segment when the source is only a fence', () => {
    const segments = segmentMarkdown('```ts\nconst x = 1;\n```');
    expect(segments).toEqual([{ kind: 'fence', language: 'ts', source: 'const x = 1;' }]);
  });

  it('orders prose, fence, prose around a fenced block', () => {
    const source = ['Before the code.', '', '```js', 'console.log(1);', '```', '', 'After the code.'].join(
      '\n',
    );
    const segments = segmentMarkdown(source);
    expect(segments.map((s) => s.kind)).toEqual(['prose', 'fence', 'prose']);
    expect(segments[1]).toEqual({ kind: 'fence', language: 'js', source: 'console.log(1);' });
  });

  it('coalesces consecutive paragraphs into a single prose segment', () => {
    const source = ['First paragraph.', '', 'Second paragraph.', '', 'Third paragraph.'].join('\n');
    const segments = segmentMarkdown(source);
    expect(segments.length).toBe(1);
    expect(segments[0]?.kind).toBe('prose');
  });

  it('takes only the first whitespace-separated word of the info string, lowercased', () => {
    const segments = segmentMarkdown('```ts title=x.ts\nconst x = 1;\n```');
    expect(segments[0]).toEqual({ kind: 'fence', language: 'ts', source: 'const x = 1;' });
  });

  it('uses an uppercase info string lowercased', () => {
    const segments = segmentMarkdown('```TypeScript\nconst x = 1;\n```');
    expect(segments[0]).toMatchObject({ language: 'typescript' });
  });

  it('yields an empty language for an unlabelled fence', () => {
    const segments = segmentMarkdown('```\nplain\n```');
    expect(segments[0]).toEqual({ kind: 'fence', language: '', source: 'plain' });
  });

  it('treats a 4-space-indented code block as a fence segment with no language', () => {
    const source = 'Paragraph.\n\n    indented code\n    line two\n';
    const segments = segmentMarkdown(source);
    expect(segments.map((s) => s.kind)).toEqual(['prose', 'fence']);
    const fence = segments[1];
    expect(fence?.kind).toBe('fence');
    if (fence?.kind === 'fence') {
      expect(fence.language).toBe('');
      expect(fence.source).toBe('indented code\nline two');
    }
  });

  it('preserves prose text verbatim, so round-tripping segments loses no user content', () => {
    const source = [
      '# Heading',
      '',
      'Some *prose* with a [link](https://example.com) and `inline code`.',
      '',
      '> A blockquote.',
      '',
      '```py',
      'print("hi")',
      '```',
      '',
      '- item one',
      '- item two',
    ].join('\n');

    const segments = segmentMarkdown(source);
    const proseText = segments
      .filter((s): s is { kind: 'prose'; text: string } => s.kind === 'prose')
      .map((s) => s.text)
      .join('');

    // Removing the fence's own raw text from the source is the only thing that should be
    // missing from the coalesced prose — everything else round-trips verbatim, in order.
    const fenceRaw = '```py\nprint("hi")\n```';
    expect(proseText).toBe(source.replace(fenceRaw, ''));
    expect(proseText).not.toContain('print("hi")');
  });
});
