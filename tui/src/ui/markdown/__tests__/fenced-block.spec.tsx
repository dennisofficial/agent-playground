import type { ScrollBoxRenderable } from '@opentui/core';
import { testRender } from '@opentui/react/test-utils';
import { describe, expect, it } from 'bun:test';
import React from 'react';
import { CONTENT_PADDING } from '../fenced-block.js';
import { MarkdownView } from '../markdown-view.js';

/**
 * Mounts a fence inside a scrolling transcript, because every claim here is about what the WHEEL
 * does when two scroll containers are nested — which nothing short of a real renderer knows. The
 * previous attempt at nested scrolling typechecked, passed its unit tests, and destroyed the
 * transcript layout.
 *
 * Coordinates are terminal cells: the fence body sits a couple of rows below the block's top border,
 * and the filler above it is what gives the outer scrollbox something to scroll.
 */

const WIDTH = 60;
const HEIGHT = 20;

const WIDE_FENCE = ['```ts', `const wide = ${"'x'".repeat(40)};`, 'const last = 2;', '```'].join('\n');
const FILLER = Array.from({ length: 25 }, (_, i) => `filler line ${i}`).join('\n\n');

/** The row the fence's first code line lands on, read off the rendered frame rather than assumed. */
function rowOf(frame: string, needle: string): number {
  return frame.split('\n').findIndex((line) => line.includes(needle));
}

/**
 * The CODE on a fence row, with the block's chrome removed.
 *
 * A pan is a claim about content, so the comparison has to start where the content does — past the
 * left border and the block's padding. Derived rather than a literal column, so a change to either
 * moves these tests with it instead of breaking them.
 */
function codeOf(line: string | undefined): string {
  if (!line) return '';
  const border = line.indexOf('│');
  return border < 0 ? line : line.slice(border + 1 + CONTENT_PADDING);
}

async function mount(source: string) {
  let outer: ScrollBoxRenderable | null = null;
  const setup = await testRender(
    <box flexDirection="column" width={WIDTH} height={HEIGHT}>
      <scrollbox
        flexGrow={1}
        stickyScroll
        stickyStart="bottom"
        ref={(r: ScrollBoxRenderable | null) => {
          outer = r;
        }}
      >
        <box flexDirection="column">
          <MarkdownView source={source} width={WIDTH - 4} />
        </box>
      </scrollbox>
    </box>,
    { width: WIDTH, height: HEIGHT },
  );
  await setup.flush();
  return { setup, outer: () => outer as ScrollBoxRenderable | null };
}

describe('FencedBlock', () => {
  it('keeps a wide fence at its natural width instead of wrapping it', async () => {
    const { setup } = await mount(`${FILLER}\n\n${WIDE_FENCE}`);
    try {
      const frame = setup.captureCharFrame();
      // Wrapping would push `const last` down a row and split the long line across two; the marker
      // for "not wrapped" is that both source lines are on adjacent rows.
      expect(rowOf(frame, 'const last = 2;') - rowOf(frame, 'const wide =')).toBe(1);
    } finally {
      setup.renderer.destroy();
    }
  }, 30_000);

  it('pans the fence sideways on a horizontal wheel, without moving the transcript', async () => {
    const { setup, outer } = await mount(`${FILLER}\n\n${WIDE_FENCE}`);
    try {
      const before = setup.captureCharFrame();
      const codeRow = rowOf(before, 'const wide =');
      const scrollTop = outer()?.scrollTop;

      await setup.mockMouse.scroll(10, codeRow, 'right');
      await setup.flush();

      const after = setup.captureCharFrame();
      expect(after.split('\n')[codeRow]).not.toBe(before.split('\n')[codeRow]);
      expect(outer()?.scrollTop).toBe(scrollTop);
    } finally {
      setup.renderer.destroy();
    }
  }, 30_000);

  it('pans one column per report on alt+wheel, the spelling every terminal delivers', async () => {
    const { setup, outer } = await mount(`${FILLER}\n\n${WIDE_FENCE}`);
    try {
      const codeRow = rowOf(setup.captureCharFrame(), 'const wide =');
      const before = setup.captureCharFrame().split('\n')[codeRow] ?? '';
      const scrollTop = outer()?.scrollTop;

      // Zed reports no horizontal wheel and drops shift+scroll, so alt is the only spelling that
      // survives there — measured against Zed's raw SGR reports. Up walks forward through the block.
      await setup.mockMouse.scroll(10, codeRow, 'up', { modifiers: { alt: true } });
      await setup.flush();

      const after = setup.captureCharFrame().split('\n')[codeRow] ?? '';
      expect(codeOf(after).slice(0, 19)).toBe(codeOf(before).slice(1, 20));
      // The page must not move while the block is being panned with the wheel.
      expect(outer()?.scrollTop).toBe(scrollTop);
    } finally {
      setup.renderer.destroy();
    }
  }, 30_000);

  it('pans when its scrollbar is dragged', async () => {
    const { setup, outer } = await mount(`${FILLER}\n\n${WIDE_FENCE}`);
    try {
      const lines = setup.captureCharFrame().split('\n');
      const codeRow = rowOf(setup.captureCharFrame(), 'const wide =');
      const barRow = lines.findIndex((line, i) => i > codeRow && line.includes('━'));
      const before = lines[codeRow];
      const scrollTop = outer()?.scrollTop;

      await setup.mockMouse.drag(3, barRow, 30, barRow);
      await setup.flush();

      expect(setup.captureCharFrame().split('\n')[codeRow]).not.toBe(before);
      // Pressing on the bar must not start a transcript text selection or move the page.
      expect(outer()?.scrollTop).toBe(scrollTop);
    } finally {
      setup.renderer.destroy();
    }
  }, 30_000);

  it('pans one column per report, so a swipe scrolls rather than jumps', async () => {
    const { setup } = await mount(`${FILLER}\n\n${WIDE_FENCE}`);
    try {
      const codeRow = rowOf(setup.captureCharFrame(), 'const wide =');

      // The fence's own text, read off the row: everything up to the block's right border.
      const textAt = (frame: string): string => codeOf(frame.split('\n')[codeRow]);
      const start = textAt(setup.captureCharFrame());

      await setup.mockMouse.scroll(10, codeRow, 'right');
      await setup.flush();

      // One column, not a viewport fraction: the row is its old self shifted by exactly one cell.
      expect(textAt(setup.captureCharFrame()).slice(0, 20)).toBe(start.slice(1, 21));
    } finally {
      setup.renderer.destroy();
    }
  }, 30_000);

  it('pans once, not twice, when shift rides along on a sideways report', async () => {
    const { setup } = await mount(`${FILLER}\n\n${WIDE_FENCE}`);
    try {
      const codeRow = rowOf(setup.captureCharFrame(), 'const wide =');
      const before = setup.captureCharFrame().split('\n')[codeRow] ?? '';

      // macOS turns shift+scroll into a HORIZONTAL scroll before the terminal ever sees it, so on a
      // trackpad the shift spelling and a plain sideways swipe arrive as the same left/right report
      // with shift set. Reading shift first made this match no branch at all and the block sat
      // still; applying both spellings would move it two columns for one report.
      await setup.mockMouse.scroll(10, codeRow, 'right', { modifiers: { shift: true } });
      await setup.flush();

      const after = setup.captureCharFrame().split('\n')[codeRow] ?? '';
      expect(codeOf(after).slice(0, 19)).toBe(codeOf(before).slice(1, 20));
    } finally {
      setup.renderer.destroy();
    }
  }, 30_000);

  it('scrolls the transcript on a plain vertical wheel over a fence', async () => {
    const { setup, outer } = await mount(`${FILLER}\n\n${WIDE_FENCE}`);
    try {
      const codeRow = rowOf(setup.captureCharFrame(), 'const wide =');
      const scrollTop = outer()?.scrollTop ?? 0;

      // The fence keeps only the sideways axis. Up and down belong to the page, whatever the pointer
      // happens to be resting on, so this must move the transcript and NOT pan the block.
      await setup.mockMouse.scroll(10, codeRow, 'up');
      await setup.flush();

      expect(outer()?.scrollTop).toBeLessThan(scrollTop);
    } finally {
      setup.renderer.destroy();
    }
  }, 30_000);

  it('holds the transcript still for the vertical component of a sideways swipe', async () => {
    const { setup, outer } = await mount(`${FILLER}\n\n${WIDE_FENCE}`);
    try {
      const codeRow = rowOf(setup.captureCharFrame(), 'const wide =');

      // A trackpad flick sideways: mostly horizontal reports, with a stray vertical one riding
      // along. The stray one must not drift the page out from under the block being panned.
      await setup.mockMouse.scroll(10, codeRow, 'right');
      await setup.flush();
      const scrollTop = outer()?.scrollTop ?? 0;

      await setup.mockMouse.scroll(10, codeRow, 'up');
      await setup.flush();

      expect(outer()?.scrollTop).toBe(scrollTop);
    } finally {
      setup.renderer.destroy();
    }
  }, 30_000);

  it('shrinks a short fence to its content instead of the viewport', async () => {
    const { setup } = await mount(['```ts', 'const x = 1;', '```'].join('\n'));
    try {
      const lines = setup.captureCharFrame().split('\n');
      const bottom = lines.find((line) => line.includes('╰'))?.replace(/\s+$/, '') ?? '';
      // `const x = 1;` is twelve columns, plus a border either side — nowhere near the sixty the
      // block used to be drawn at.
      expect(bottom.length).toBeLessThan(WIDTH / 2);
      // The header still carries both of the things that live in it.
      const top = lines.find((line) => line.includes('╭')) ?? '';
      expect(top).toContain(' ts ');
      expect(top).toContain('copy');
    } finally {
      setup.renderer.destroy();
    }
  }, 30_000);

  it('never shrinks below the header, which would cost it the copy button', async () => {
    // Two columns of content against a header that needs far more than two.
    const { setup } = await mount(['```ts', 'x', '```'].join('\n'));
    try {
      const top = setup.captureCharFrame().split('\n').find((line) => line.includes('╭')) ?? '';
      expect(top).toContain(' ts ');
      expect(top).toContain('copy');
    } finally {
      setup.renderer.destroy();
    }
  }, 30_000);

  it('leaves the transcript scrolling normally over prose', async () => {
    const { setup, outer } = await mount(`${FILLER}\n\n${WIDE_FENCE}`);
    try {
      const proseRow = rowOf(setup.captureCharFrame(), 'filler line');
      const scrollTop = outer()?.scrollTop ?? 0;

      await setup.mockMouse.scroll(10, proseRow >= 0 ? proseRow : 1, 'up');
      await setup.flush();

      expect(outer()?.scrollTop).toBeLessThan(scrollTop);
    } finally {
      setup.renderer.destroy();
    }
  }, 30_000);
});
