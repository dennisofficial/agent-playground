import { parseColor, type CapturedFrame, type RGBA } from '@opentui/core';
import { testRender } from '@opentui/react/test-utils';
import { describe, expect, it } from 'bun:test';
import React from 'react';
import { EHarnessVariant } from '../../domain/message.js';
import { HarnessBlock } from '../components/blocks/harness-block.js';
import { registerGrammars } from '../markdown/grammars/index.js';
import { theme } from '../theme.js';

// A `TreeSitterClient` takes the default parser set once, at construction — so the grammars have to
// be in place before the first renderer builds one.
await registerGrammars();

/**
 * Atlas's slab, drawn for real and read back off the frame.
 *
 * Asserted here rather than in `domain/` because the thing under test IS the pixels: "whose message
 * is this" is carried by a BACKGROUND and a one-column rule, and neither survives as a string. The
 * markdown half is asserted the only way markdown can be — by what is NOT on the frame, since the
 * proof that `##` was parsed rather than printed is that the `#`s are gone.
 */

const WIDTH = 60;

const MARKDOWN = ['## Slice 2', '', 'I rejected a **shared** cache.'].join('\n');

async function draw(text: string): Promise<{
  frame: CapturedFrame;
  chars: string[];
  destroy: () => void;
}> {
  const setup = await testRender(
    <box flexDirection="column" width={WIDTH} height={12}>
      <HarnessBlock variant={EHarnessVariant.handoff} text={text} width={WIDTH} />
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

/** The first cell of a row: the accent rule, if the row is inside the slab. */
function edge(frame: CapturedFrame, row: number): RGBA | undefined {
  return frame.lines[row]?.spans[0]?.bg;
}

function rowsWith(frame: CapturedFrame, colour: string): number[] {
  const wanted = parseColor(colour);
  return frame.lines
    .map((line, row) => ({ row, spans: line.spans }))
    .filter(({ spans }) => spans.some((span) => span.bg.equals(wanted)))
    .map(({ row }) => row);
}

describe('HarnessBlock', () => {
  it('draws a slab in its own hue, with the accent as a rule down its edge', async () => {
    const { frame, destroy } = await draw(MARKDOWN);
    try {
      const slab = rowsWith(frame, theme.harnessBg);
      // The label, a blank, the heading, a blank, the prose — the point is that the slab covers the
      // WHOLE block and not just the line the label is on.
      expect(slab.length).toBeGreaterThanOrEqual(4);
      expect(slab).toEqual(
        Array.from({ length: slab.length }, (_, i) => (slab[0] ?? 0) + i),
      );

      // The rule runs the full height beside it, in the accent — one column, every row.
      for (const row of slab) {
        expect(edge(frame, row)?.equals(parseColor(theme.accent))).toBe(true);
      }

      // Not the user's slab: hue is the only thing separating the two speakers, so if these ever
      // become the same colour the block stops saying who wrote it.
      expect(parseColor(theme.harnessBg).equals(parseColor(theme.userBg))).toBe(false);
    } finally {
      destroy();
    }
  }, 30_000);

  it('renders its text as markdown, not as the bytes the model was sent', async () => {
    const { chars, destroy } = await draw(MARKDOWN);
    try {
      const drawn = chars.join('\n');
      expect(drawn).toContain('atlas · handoff');
      expect(drawn).toContain('Slice 2');
      expect(drawn).toContain('shared');
      // The evidence: the syntax was consumed. A verbatim render would still have both markers.
      expect(drawn).not.toContain('##');
      expect(drawn).not.toContain('**');
    } finally {
      destroy();
    }
  }, 30_000);
});
