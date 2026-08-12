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
      // Nothing to click until the pointer is in the block, so the button is fetched by hovering the
      // fence's top border rather than by searching a resting frame that has no button on it.
      const border = setup.captureCharFrame().split('\n').findIndex((line) => line.includes('╭'));
      await hover(setup, setup.captureCharFrame().split('\n')[border]?.indexOf('╭') ?? 0, border);

      const lines = setup.captureCharFrame().split('\n');
      const row = lines.findIndex((line) => line.includes('copy'));
      expect(row).toBe(border);

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
      const border = setup.captureCharFrame().split('\n').findIndex((line) => line.includes('╭'));
      await hover(setup, 1, border);

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

  it('stays out of the border until the pointer is somewhere in the block', async () => {
    const setup = await testRender(
      <box flexDirection="column" width={60} height={12}>
        <MarkdownView source={FENCE} width={56} />
      </box>,
      { width: 60, height: 12 },
    );
    try {
      await setup.flush();
      const resting = setup.captureCharFrame().split('\n');
      const border = resting.findIndex((line) => line.includes('╭'));
      // A transcript is mostly fences; at rest the header carries the language and nothing else.
      expect(resting[border]).not.toContain('copy');
      expect(resting[border]).toContain(' ts ');

      // The CODE, not the header: the whole block is the hover target, not just the border the
      // button is drawn on — reaching it should not require finding the one row it lives on.
      const code = resting.findIndex((line) => line.includes('const answer'));
      await hover(setup, 4, code);
      const shown = setup.captureCharFrame().split('\n');
      expect(shown[border]).toContain('copy');
      // Revealing it must not move the fence's corner: the button's columns are always spoken for,
      // border when it is hidden, label when it is not.
      expect(shown[border]?.trimEnd().length).toBe(resting[border]?.trimEnd().length);

      // Off the block entirely — the empty rows below it — and the border closes back up.
      await hover(setup, 40, 11);
      expect(setup.captureCharFrame().split('\n')[border]).not.toContain('copy');
    } finally {
      setup.renderer.destroy();
    }
  }, 30_000);

  it('holds its report on screen after the pointer has left the block', async () => {
    const setup = await testRender(
      <box flexDirection="column" width={60} height={12}>
        <MarkdownView source={FENCE} width={56} />
      </box>,
      { width: 60, height: 12 },
    );
    try {
      await setup.flush();
      const border = setup.captureCharFrame().split('\n').findIndex((line) => line.includes('╭'));
      await hover(setup, 1, border);
      const column = setup.captureCharFrame().split('\n')[border]?.indexOf('⧉') ?? -1;

      await setup.mockMouse.click(column, border);
      await setup.flush();

      // Copying is often the last thing done in a block, so the pointer leaves immediately after the
      // click. Hiding the button on the way out would swallow the only report the click makes.
      await hover(setup, 40, 11);
      const after = setup.captureCharFrame().split('\n')[border];
      expect(after?.includes('copied') || after?.includes('blocked')).toBe(true);
    } finally {
      setup.renderer.destroy();
    }
  }, 30_000);
});
