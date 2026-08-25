import { parseColor, type CapturedFrame } from '@opentui/core';
import { testRender } from '@opentui/react/test-utils';
import { describe, expect, it } from 'bun:test';
import React from 'react';
import { UserBlock } from '../components/blocks/user-block.js';
import { registerGrammars } from '../markdown/grammars/index.js';
import { glyph, theme } from '../theme.js';

// A `TreeSitterClient` takes the default parser set once, at construction — so the grammars have to
// be in place before the first renderer builds one.
await registerGrammars();

/**
 * The user's slab, drawn for real and read back off the frame.
 *
 * Asserted here rather than in `domain/` for the reason `harness-block.spec` gives: the thing under
 * test IS the pixels. "Whose message is this" is carried by a BACKGROUND, which does not survive as
 * a string, and the proof that markdown was parsed rather than printed is that the markers are gone.
 */

const WIDTH = 60;

const MARKDOWN = [
  '## Do the thing',
  '',
  'Use `paths.ts` and make it **fast**.',
].join('\n');

async function draw(text: string): Promise<{
  frame: CapturedFrame;
  chars: string[];
  destroy: () => void;
}> {
  const setup = await testRender(
    <box flexDirection="column" width={WIDTH} height={12}>
      <UserBlock text={text} width={WIDTH} />
    </box>,
    { width: WIDTH, height: 12 },
  );
  await setup.flush();
  // Highlighting is a round trip to the parser worker — a block renders plain first and gains its
  // styling a moment later, so a frame captured too early is the unparsed one.
  await new Promise((resolve) => setTimeout(resolve, 40));
  await setup.flush();
  return {
    frame: setup.captureSpans(),
    chars: setup.captureCharFrame().split('\n'),
    destroy: () => setup.renderer.destroy(),
  };
}

function rowsWith(frame: CapturedFrame, colour: string): number[] {
  const wanted = parseColor(colour);
  return frame.lines
    .map((line, row) => ({ row, spans: line.spans }))
    .filter(({ spans }) => spans.some((span) => span.bg.equals(wanted)))
    .map(({ row }) => row);
}

describe('UserBlock', () => {
  it('renders the text as markdown, not as the bytes that were typed', async () => {
    const { chars, destroy } = await draw(MARKDOWN);
    try {
      const drawn = chars.join('\n');
      expect(drawn).toContain(glyph.user);
      expect(drawn).toContain('Do the thing');
      expect(drawn).toContain('paths.ts');
      expect(drawn).toContain('fast');
      // The evidence: the syntax was consumed. A verbatim render would still have every marker.
      expect(drawn).not.toContain('##');
      expect(drawn).not.toContain('**');
      expect(drawn).not.toContain('`');
    } finally {
      destroy();
    }
  }, 30_000);

  it('keeps the slab under every row of a laid-out block', async () => {
    const { frame, destroy } = await draw(MARKDOWN);
    try {
      const slab = rowsWith(frame, theme.userBg);
      // The heading, a blank, the prose — the point is that turning the body into a laid-out
      // column did not leave the wrapped rows sitting on the terminal's own background.
      expect(slab.length).toBeGreaterThanOrEqual(3);
      expect(slab).toEqual(
        Array.from({ length: slab.length }, (_, i) => (slab[0] ?? 0) + i),
      );

      // Hue is the only thing separating the two speakers.
      expect(parseColor(theme.userBg).equals(parseColor(theme.harnessBg))).toBe(
        false,
      );
    } finally {
      destroy();
    }
  }, 30_000);

  it('wraps a long line inside the slab instead of running past it', async () => {
    const { chars, destroy } = await draw(
      `wrap ${'word '.repeat(40)}`.trimEnd(),
    );
    try {
      // Nothing may exceed the frame — a body handed the wrong column count overflows silently.
      for (const line of chars) expect(line.length).toBeLessThanOrEqual(WIDTH);
      expect(chars.filter((line) => line.includes('word')).length).toBeGreaterThan(
        1,
      );
    } finally {
      destroy();
    }
  }, 30_000);
});
