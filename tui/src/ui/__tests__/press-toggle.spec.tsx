import { testRender } from "@opentui/react/test-utils";
import { beforeEach, describe, expect, it, mock } from "bun:test";
import React, { act, useState } from "react";

const copies: string[] = [];

void mock.module("../clipboard.js", () => ({
  copyToClipboard: (_renderer: unknown, text: string) => {
    copies.push(text);
    return true;
  },
}));

// Imported after the mock is registered, so the module under test binds to it.
const { useClickRegion } = await import("../hooks/use-click-region.js");
const { useCopyOnSelect } = await import("../copy-on-select.js");

const WIDTH = 30;
const HEIGHT = 8;
/** Enough to fill the viewport, so the transcript is scrolled and sticky to the bottom. */
const FILLER = Array.from({ length: 12 }, (_, index) => `filler ${index}`);
const BODY = ["body one", "body two", "body three", "body four"];
const SUMMARY = "summary row";

/**
 * The transcript's real geometry in miniature: a sticky-bottom scrollbox whose rows all move when a
 * block in it opens. That movement is the whole bug — see `usePress`.
 */
function Harness(): React.ReactNode {
  useCopyOnSelect();
  const [open, setOpen] = useState(false);
  const { handlers } = useClickRegion(() => setOpen((current) => !current));
  return (
    <box flexDirection="column" width={WIDTH} height={HEIGHT}>
      <scrollbox flexGrow={1} focusable={false} stickyScroll stickyStart="bottom">
        {FILLER.map((line) => (
          <text key={line}>{line}</text>
        ))}
        <text {...handlers}>{SUMMARY}</text>
        {open
          ? BODY.map((line) => (
              <text key={line} {...handlers}>
                {line}
              </text>
            ))
          : null}
      </scrollbox>
    </box>
  );
}

async function mount() {
  const setup = await testRender(<Harness />, { width: WIDTH, height: HEIGHT });
  return settled(setup);
}

type Setup = Awaited<ReturnType<typeof testRender>>;

/**
 * Drained until the layout has actually MOVED, not just until the event was delivered.
 *
 * A toggle is a `setState` from a renderer event, so the reflow lands a render after the flush that
 * carried the click — and this bug lives entirely in what happens between the two. A single flush
 * would hide it.
 */
async function settled(setup: Setup): Promise<Setup> {
  await act(async () => {
    await setup.flush();
  });
  await act(async () => {
    await setup.flush();
  });
  await setup.flush();
  return setup;
}

function rowOf(setup: Setup, text: string): number {
  const row = setup
    .captureCharFrame()
    .split("\n")
    .findIndex((line) => line.includes(text));
  expect(row).toBeGreaterThanOrEqual(0);
  return row;
}

beforeEach(() => {
  copies.length = 0;
});

describe("expanding a block", () => {
  /**
   * The reported bug, in the order the terminal reports it.
   *
   * Press and release are two events with a human pause between them, and acting on the PRESS meant
   * the block had already reflowed by the time the release arrived. The renderer takes its selection
   * anchor relative to the renderable under the pointer, so the anchor rode the rows upwards while
   * the focus point stayed where the pointer was — and the release settled a drag the user never
   * made, lighting up the page and putting it on the clipboard. Settling between the two halves is
   * what makes that pause real.
   */
  it("opens without leaving the page looking dragged over", async () => {
    const setup = await mount();
    try {
      const row = rowOf(setup, SUMMARY);

      await setup.mockMouse.pressDown(2, row);
      await settled(setup);
      await setup.mockMouse.release(2, row);
      await settled(setup);

      // It opened...
      expect(setup.captureCharFrame()).toContain("body four");
      // ...and took nothing with it.
      expect(setup.renderer.hasSelection).toBe(false);
      expect(copies).toEqual([]);
    } finally {
      setup.renderer.destroy();
    }
  });

  it("closes on a click anywhere in the block, and only where the press began", async () => {
    const setup = await mount();
    try {
      await setup.mockMouse.click(2, rowOf(setup, SUMMARY));
      await settled(setup);
      expect(setup.captureCharFrame()).toContain("body one");

      // A body line is part of the block, so it closes it — the rule the handlers are spread for.
      await setup.mockMouse.click(2, rowOf(setup, "body two"));
      await settled(setup);
      expect(setup.captureCharFrame()).not.toContain("body two");

      // A release that lands on the block after a press that did not is somebody else's gesture.
      await setup.mockMouse.pressDown(2, rowOf(setup, "filler 9"));
      await settled(setup);
      await setup.mockMouse.release(2, rowOf(setup, SUMMARY));
      await settled(setup);
      expect(setup.captureCharFrame()).not.toContain("body one");
    } finally {
      setup.renderer.destroy();
    }
  });

  /**
   * The other half of what waiting for the release buys: a drag that STARTS on a clickable row is a
   * drag. Under the old rule the press collapsed the block first, so the text a reader wanted to copy
   * was never there to be selected.
   */
  it("lets a drag across the block select instead of toggling it", async () => {
    const setup = await mount();
    try {
      const row = rowOf(setup, SUMMARY);
      await setup.mockMouse.drag(0, row, 10, row);
      await settled(setup);

      expect(copies.length).toBe(1);
      expect(copies[0]).toContain("summary");
      expect(setup.captureCharFrame()).not.toContain("body one");
    } finally {
      setup.renderer.destroy();
    }
  });
});
