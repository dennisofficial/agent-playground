import { testRender } from '@opentui/react/test-utils';
import { describe, expect, it } from 'bun:test';
import React from 'react';
import { CONVERSATION, EDITING, GLOBAL } from '../bindings.js';
import { Shortcuts, shortcutRows } from '../components/shortcuts.js';

/**
 * The panel's whole job is to fit — it opens INSIDE a footer, on top of a transcript, at whatever
 * size the terminal happens to be. So the assertions are the two ways it can fail the frame: spill
 * past the right edge, or take more rows than the footer can spare.
 */

const BINDINGS = [...CONVERSATION, ...EDITING, ...GLOBAL];

/** Every non-blank rendered row, trailing padding removed. */
async function render(width: number, height: number): Promise<string[]> {
  const setup = await testRender(
    <box flexDirection="column" width={width} height={height}>
      <Shortcuts bindings={BINDINGS} width={width} maxRows={shortcutRows(height)} />
    </box>,
    { width, height },
  );
  try {
    await setup.flush();
    return setup
      .captureCharFrame()
      .split('\n')
      .map((line) => line.replace(/\s+$/, ''))
      .filter((line) => line.length > 0);
  } finally {
    setup.renderer.destroy();
  }
}

describe('the shortcuts panel', () => {
  // A wide-and-short terminal is the hard case: the budget wants columns and the width has to give
  // them, shaving descriptions rather than spending rows.
  for (const [width, height] of [
    [160, 50],
    [100, 40],
    [100, 20],
    [72, 30],
    [60, 24],
  ] as const) {
    it(`fits ${width}×${height}`, async () => {
      const lines = await render(width, height);

      expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(width);
      expect(lines.length).toBeLessThanOrEqual(shortcutRows(height));
      // Nothing may be dropped on the way in: every binding is somewhere on screen, by its key.
      for (const [key] of BINDINGS) expect(lines.some((line) => line.includes(key))).toBe(true);
    }, 30_000);
  }

  it('reads down each column, not across', async () => {
    const lines = await render(100, 20);
    // `⏎` and `shift+⏎` are the first two bindings, so a column-major layout puts them on
    // consecutive ROWS of the first column — row-major would put the second one across the gap.
    expect(lines[0]?.indexOf('⏎')).toBe(lines[1]?.indexOf('shift+⏎') ?? -1);
  }, 30_000);
});
