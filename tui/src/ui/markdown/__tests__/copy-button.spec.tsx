import { parseColor, type CapturedFrame, type RGBA } from '@opentui/core';
import { testRender } from '@opentui/react/test-utils';
import { describe, expect, it } from 'bun:test';
import React, { act } from 'react';
import { theme } from '../../theme.js';
import { MarkdownView } from '../markdown-view.js';

/**
 * A click, driven through the renderer's real hit grid.
 *
 * The claim under test is that the button is REACHABLE — that a `<text>` nested several boxes deep
 * inside a scrolling transcript receives a mouse press at its own coordinates. Nothing about that is
 * visible to the type system, and the label is the only evidence the reader gets that a copy
 * happened, so the label is what this asserts on.
 */

const FENCE = ['```ts', 'const answer = 42;', '```'].join('\n');

/** The colour the label is actually drawn in, read back off the frame. */
function labelColour(frame: CapturedFrame, row: number): RGBA | undefined {
  return frame.lines[row]?.spans.find((span) => span.text.includes('copy'))?.fg;
}

/**
 * Move the pointer and let the recolour land on the frame.
 *
 * `testRender` renders inside `act`, so a `setState` from a hover handler is only committed when the
 * event is dispatched inside `act` too — and the committed tree only reaches the buffer on the flush
 * AFTER that. Nothing here is a property of hovering; it is the harness's render loop.
 */
async function hover(
  setup: { mockMouse: { moveTo: (x: number, y: number) => Promise<void> }; flush: () => Promise<void> },
  x: number,
  y: number,
): Promise<void> {
  await act(async () => {
    await setup.mockMouse.moveTo(x, y);
    await setup.flush();
  });
  await setup.flush();
}

describe('CopyButton', () => {
  it('copies the block on a click, and says so', async () => {
    const setup = await testRender(
      <box flexDirection="column" width={60} height={12}>
        <scrollbox flexGrow={1}>
          <box flexDirection="column">
            <MarkdownView source={FENCE} width={56} />
          </box>
        </scrollbox>
      </box>,
      { width: 60, height: 12 },
    );
    try {
      await setup.flush();
      const lines = setup.captureCharFrame().split('\n');
      const row = lines.findIndex((line) => line.includes('copy'));
      expect(row).toBeGreaterThanOrEqual(0);

      // On the fence's top border, opposite the language — not on a row of its own. A copy button
      // is on every fence, so a dedicated row would cost a two-line snippet its own height again.
      expect(lines[row]).toContain('╭');
      expect(lines[row]).toContain(' ts ');

      // The button sits at the right edge of the block; click its glyph rather than its text so the
      // test fails if the label grows and the hit area does not.
      const column = lines[row]?.indexOf('⧉') ?? -1;
      expect(column).toBeGreaterThanOrEqual(0);

      await setup.mockMouse.click(column, row);
      await setup.flush();

      // OSC 52 is unsupported in the in-memory test terminal and `pbcopy` is not reached from a
      // test, so the honest outcome here is the refusal label — which is the point: the button
      // reports what happened rather than always claiming success.
      const after = setup.captureCharFrame().split('\n');
      expect(after[row]?.includes('copied') || after[row]?.includes('blocked')).toBe(true);
      // The border must not change length under the pointer: every label is drawn at one width.
      expect(after[row]?.replace(/\s+$/, '').length).toBe(lines[row]?.replace(/\s+$/, '').length);
    } finally {
      setup.renderer.destroy();
    }
  }, 30_000);

  it('brightens under the pointer and settles back when it leaves', async () => {
    const setup = await testRender(
      <box flexDirection="column" width={60} height={12}>
        <MarkdownView source={FENCE} width={56} />
      </box>,
      { width: 60, height: 12 },
    );
    try {
      await setup.flush();
      const lines = setup.captureCharFrame().split('\n');
      const row = lines.findIndex((line) => line.includes('copy'));
      const column = lines[row]?.indexOf('⧉') ?? -1;
      expect(column).toBeGreaterThanOrEqual(0);

      // Parked one column off the corner, at the far end of the border from the language.
      expect(lines[row]?.trimEnd().endsWith('copy ─╮')).toBe(true);

      const resting = labelColour(setup.captureSpans(), row);
      expect(resting?.equals(parseColor(theme.dim))).toBe(true);

      await hover(setup, column, row);
      expect(labelColour(setup.captureSpans(), row)?.equals(parseColor(theme.hover))).toBe(true);

      // Off the button but still on the same border line: the brightening tracks the button, not the
      // row, or every fence would light up whenever the pointer crossed it.
      await hover(setup, 2, row);
      expect(labelColour(setup.captureSpans(), row)?.equals(parseColor(theme.dim))).toBe(true);
    } finally {
      setup.renderer.destroy();
    }
  }, 30_000);
});
