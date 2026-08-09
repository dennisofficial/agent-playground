import type { ScrollBoxRenderable } from '@opentui/core';
import { testRender } from '@opentui/react/test-utils';
import { describe, expect, it } from 'bun:test';
import React from 'react';
import { MarkdownView } from '../markdown-view.js';
import { proseSyntaxStyle } from '../syntax-style.js';
import { measureTable, TABLE_OPTIONS } from '../table-metrics.js';

/**
 * The table half of the nested-scroll model, mounted for real.
 *
 * `measureTable` predicts the renderer's geometry from the source, and the scroll container is sized
 * from that prediction — so a change in OpenTUI's table style has to fail HERE, in a comparison
 * against the real renderer, rather than downstream as a table that overlaps its neighbours. The
 * last attempt at nested scrolling passed its unit tests and destroyed the transcript layout.
 */

const WIDTH = 60;

const WIDE_TABLE = [
  '| Engine | Model | Notes |',
  '| --- | --- | --- |',
  '| claude | opus | a much longer note that pushes this table well past sixty columns |',
  '| codex | gpt | short |',
].join('\n');

const NARROW_TABLE = ['| a | b |', '| --- | --- |', '| 1 | 2 |'].join('\n');

function frameLines(frame: string): string[] {
  return frame.split('\n').map((line) => line.replace(/\s+$/, ''));
}

async function mount(source: string) {
  let outer: ScrollBoxRenderable | null = null;
  const setup = await testRender(
    <box flexDirection="column" width={WIDTH} height={24}>
      <scrollbox
        flexGrow={1}
        ref={(r: ScrollBoxRenderable | null) => {
          outer = r;
        }}
      >
        <box flexDirection="column">
          <text>HEAD MARKER</text>
          <MarkdownView source={source} width={WIDTH - 4} />
          <text>TAIL MARKER</text>
        </box>
      </scrollbox>
    </box>,
    { width: WIDTH, height: 24 },
  );
  await setup.flush();
  return { setup, outer: () => outer as ScrollBoxRenderable | null };
}

describe('measureTable', () => {
  it('predicts the renderer\'s own geometry', async () => {
    // The prediction, then the same table rendered unconstrained at that width. If OpenTUI's table
    // style changes, these stop agreeing.
    const metrics = measureTable(WIDE_TABLE);
    const setup = await testRender(
      <box flexDirection="column" width={metrics.columns + 2} height={24}>
        {/* The SAME options the transcript draws with — a prediction measured against a differently
            styled table would agree about nothing that matters. */}
        <markdown
          content={WIDE_TABLE}
          syntaxStyle={proseSyntaxStyle}
          tableOptions={TABLE_OPTIONS}
          width={metrics.columns}
        />
      </box>,
      { width: metrics.columns + 2, height: 24 },
    );
    try {
      await setup.flush();
      const drawn = frameLines(setup.captureCharFrame()).filter((line) => line.length > 0);
      expect(drawn.length).toBe(metrics.rows);
      expect(Math.max(...drawn.map((line) => line.length))).toBe(metrics.columns);
    } finally {
      setup.renderer.destroy();
    }
  }, 30_000);

  it('ignores the alignment row and survives escaped pipes', () => {
    // Two one-character cells: each pays for its content, two columns of padding and a border, and the
    // table pays for one closing border.
    expect(measureTable(NARROW_TABLE)).toEqual({ columns: 9, rows: 5 });
    // `a\|b` is one cell of four characters, not two cells.
    expect(measureTable('| a\\|b |\n| --- |\n| x |').columns).toBe(8);
    expect(measureTable('not a table')).toEqual({ columns: 0, rows: 0 });
  });
});

describe('MarkdownView tables', () => {
  it('keeps the blocks around a wide table intact', async () => {
    const { setup } = await mount(`${WIDE_TABLE}\n\ntail prose`);
    try {
      const lines = frameLines(setup.captureCharFrame());
      const head = lines.findIndex((line) => line.includes('HEAD MARKER'));
      const tail = lines.findIndex((line) => line.includes('TAIL MARKER'));

      // Both markers present and in order is the assertion that matters: the regression this
      // guards against was the table's container growing until neighbours drew over each other.
      expect(head).toBeGreaterThanOrEqual(0);
      expect(tail).toBeGreaterThan(head);
      // The table's own rows sit between them, unwrapped: one row per source line plus borders.
      expect(tail - head - 1).toBeGreaterThanOrEqual(measureTable(WIDE_TABLE).rows);
    } finally {
      setup.renderer.destroy();
    }
  }, 30_000);

  it('pans a wide table on a horizontal wheel without moving the transcript', async () => {
    const { setup, outer } = await mount(`${WIDE_TABLE}\n\ntail prose`);
    try {
      const before = frameLines(setup.captureCharFrame());
      const row = before.findIndex((line) => line.includes('Engine'));
      const scrollTop = outer()?.scrollTop;

      // Sideways is the block's axis; up and down stay the transcript's. See `useWheelAxis`.
      await setup.mockMouse.scroll(10, row, 'right');
      await setup.flush();

      expect(frameLines(setup.captureCharFrame())[row]).not.toBe(before[row]);
      expect(outer()?.scrollTop).toBe(scrollTop);
    } finally {
      setup.renderer.destroy();
    }
  }, 30_000);

  it('pans a wide table on alt+wheel, which its scrollbox knows nothing about', async () => {
    const { setup, outer } = await mount(`${WIDE_TABLE}\n\ntail prose`);
    try {
      const before = frameLines(setup.captureCharFrame());
      const row = before.findIndex((line) => line.includes('Engine'));
      const scrollTop = outer()?.scrollTop;

      // OpenTUI's scrollbox pans itself for a horizontal report and for shift, but alt is not a
      // spelling it knows — and it is the only one Zed's terminal delivers, so the table has to
      // apply this one itself or it is unpannable exactly where the fences are not.
      await setup.mockMouse.scroll(10, row, 'up', { modifiers: { alt: true } });
      await setup.flush();

      expect(frameLines(setup.captureCharFrame())[row]).not.toBe(before[row]);
      expect(outer()?.scrollTop).toBe(scrollTop);
    } finally {
      setup.renderer.destroy();
    }
  }, 30_000);

  it('leaves a table that already fits alone', async () => {
    const { setup } = await mount(NARROW_TABLE);
    try {
      const lines = frameLines(setup.captureCharFrame());
      // No affordance line: nothing to scroll, so nothing is claimed.
      expect(lines.some((line) => line.includes('wheel'))).toBe(false);
    } finally {
      setup.renderer.destroy();
    }
  }, 30_000);

  it('draws a small table at its own width, not the transcript’s', async () => {
    // A `<markdown>` table FILLS the width it is given by padding its columns, so handing it the
    // viewport turned a four-column table into a full-width form. The border is the evidence: it ends
    // where the data ends, three columns per cell — one of content between two of padding.
    const { setup } = await mount(NARROW_TABLE);
    try {
      const top = frameLines(setup.captureCharFrame()).find((line) => line.includes('┌'));
      expect(top?.trim()).toBe(`┌${'─'.repeat(3)}┬${'─'.repeat(3)}┐`);
    } finally {
      setup.renderer.destroy();
    }
  }, 30_000);

  it('gives every cell a column of air, so the data is not flush against the rules', async () => {
    const { setup } = await mount(NARROW_TABLE);
    try {
      const row = frameLines(setup.captureCharFrame()).find((line) => /│\s*a/.test(line));
      expect(row?.trim()).toBe('│ a │ b │');
    } finally {
      setup.renderer.destroy();
    }
  }, 30_000);
});
