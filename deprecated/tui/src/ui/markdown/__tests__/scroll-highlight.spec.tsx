import { testRender } from '@opentui/react/test-utils';
import { describe, expect, it } from 'bun:test';
import React from 'react';
import { CONTENT_PADDING } from '../fenced-block.js';
import { registerGrammars } from '../grammars/index.js';
import { MarkdownView } from '../markdown-view.js';

/**
 * Highlighting has to survive PANNING, which is a claim about colours and therefore needs a real
 * renderer, a real grammar and the captured cell colours — a char frame would have passed happily
 * while the block was unreadable.
 *
 * The bug this pins: OpenTUI draws a CLIPPED styled text buffer with its text shifted and its styles
 * left where they were, so a fence drawn at its natural width inside a scrollbox showed, from about
 * column seven onwards, every character wearing the colour of one several columns to its left.
 * Measured on 0.4.5, the latest release; the fix is `TextPanner`, which never clips.
 */
await registerGrammars();

const HEIGHT = 12;
const LINE = `export const wide: string = ${"'chunk'.concat(".repeat(12)}'end');`;
const FENCE = ['```ts', LINE, '```'].join('\n');

/** Cells before the code starts: the left border, then the block's own padding. */
const CHROME_CELLS = 1 + CONTENT_PADDING;

/** The fence's row as `r,g,b:char` per cell, which is what "the colours are right" means here. */
function cells(setup: { captureSpans: () => any; captureCharFrame: () => string }): string[] {
  const row = setup.captureCharFrame().split('\n').findIndex((line) => /export|chunk|concat/.test(line));
  const out: string[] = [];
  for (const span of setup.captureSpans().lines[row]?.spans ?? []) {
    const fg = span.fg?.buffer ?? {};
    const colour = [0, 1, 2].map((i) => Math.round((fg[i] ?? 0) * 255)).join(',');
    for (const char of [...span.text]) out.push(`${colour}:${char}`);
  }
  return out;
}

/** Renders the fence at `width` and pans it `offset` columns, one wheel report at a time. */
async function pannedTo(width: number, offset: number): Promise<string[]> {
  const setup = await testRender(
    <box flexDirection="column" width={width} height={HEIGHT}>
      <MarkdownView source={FENCE} width={width - 4} />
    </box>,
    { width, height: HEIGHT },
  );
  try {
    await setup.flush();
    // Highlighting is a round trip to the Tree-sitter worker; nothing in the frame says it landed,
    // so this waits for it rather than racing it.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await setup.flush();

    for (let i = 0; i < offset; i++) await setup.mockMouse.scroll(4, 2, 'right');
    await setup.flush();
    return cells(setup);
  } finally {
    setup.renderer.destroy();
  }
}

describe('a panned fence', () => {
  it('paints every character the colour it has when the block is drawn whole', async () => {
    // The same line with room to spare: every character at its true colour, once, to compare against.
    const whole = await pannedTo(260, 0);
    expect(new Set(whole.map((cell) => cell.split(':')[0])).size).toBeGreaterThan(3);

    for (const offset of [1, 7, 13, 40]) {
      const panned = await pannedTo(60, offset);
      // Both ends are the block's chrome — border, padding, and the fold beyond it — not the content.
      const shown = panned.slice(CHROME_CELLS, panned.length - 8);
      const expected = whole.slice(CHROME_CELLS + offset, CHROME_CELLS + offset + shown.length);
      expect({ offset, shown }).toEqual({ offset, shown: expected });
    }
  }, 120_000);
});
