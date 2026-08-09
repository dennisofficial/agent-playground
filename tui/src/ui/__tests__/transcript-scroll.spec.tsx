import type { ScrollBoxRenderable } from '@opentui/core';
import { testRender } from '@opentui/react/test-utils';
import { describe, expect, it } from 'bun:test';
import React, { act } from 'react';

/**
 * The transcript scrolls by wheel and trackpad. The keyboard belongs to the composer.
 *
 * This exists because the two quietly overlapped: a scrollbox takes focus on any click, and a FOCUSED
 * scrollbox scrolls itself on ↑/↓. So selecting a line of transcript — which is a click — silently
 * signed the arrow keys up for a second job, and from then on every caret move in the draft dragged
 * the page under it. Nothing about that is visible in the types, and no unit test over the composer
 * could see it: the two features were correct on their own.
 *
 * The transcript's real geometry, mirrored from `ConversationPage`.
 */
const WIDTH = 40;
const HEIGHT = 10;
const FILLER = Array.from({ length: 40 }, (_, index) => `line ${index}`);

async function mount() {
  let box: ScrollBoxRenderable | null = null;
  const setup = await testRender(
    <box flexDirection="column" width={WIDTH} height={HEIGHT}>
      <scrollbox
        flexGrow={1}
        focusable={false}
        stickyScroll
        stickyStart="bottom"
        viewportCulling
        ref={(renderable: ScrollBoxRenderable | null) => {
          box = renderable;
        }}
      >
        {FILLER.map((line) => (
          <text key={line}>{line}</text>
        ))}
      </scrollbox>
    </box>,
    { width: WIDTH, height: HEIGHT },
  );
  await setup.flush();
  return { setup, scroller: box as unknown as ScrollBoxRenderable };
}

describe('the transcript', () => {
  it('does not take the arrow keys, even after a click in it', async () => {
    const { setup, scroller } = await mount();
    try {
      await act(async () => {
        await setup.mockMouse.click(4, 3);
        await setup.flush();
      });
      // The click must not have made it focusable's business.
      expect(scroller.focused).toBe(false);

      const before = scroller.scrollTop;
      await act(async () => {
        setup.mockInput.pressArrow('up');
        setup.mockInput.pressArrow('down');
        await setup.flush();
      });
      expect(scroller.scrollTop).toBe(before);
    } finally {
      setup.renderer.destroy();
    }
  });

  it('still scrolls on the wheel', async () => {
    const { setup, scroller } = await mount();
    try {
      const before = scroller.scrollTop;
      await act(async () => {
        await setup.mockMouse.scroll(4, 3, 'up');
        await setup.flush();
      });
      expect(scroller.scrollTop).toBeLessThan(before);
    } finally {
      setup.renderer.destroy();
    }
  });
});
