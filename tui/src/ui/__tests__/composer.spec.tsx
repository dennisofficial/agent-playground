import { testRender } from "@opentui/react/test-utils";
import { describe, expect, it } from "bun:test";
import React, { act } from "react";
import { Composer } from "../components/line-input.js";
import { useComposer } from "../hooks/use-composer.js";
import { useInput } from "../hooks/use-input.js";

const WIDTH = 30;
const HEIGHT = 16;
/** Twelve lines against a box that shows eight, so there are four rows to scroll through. */
const LINES = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`);
const DRAFT = LINES.join("\n");

function Harness(props: { maxRows?: number }): React.ReactNode {
  // `fromText` puts the caret at the very end, so the window opens at the bottom of the draft.
  const composer = useComposer(DRAFT);
  // Keys reach a composer through the page, never through the component — so the harness has to be
  // the page. Without this, typing in this test would be a no-op that looks like a scroll bug.
  useInput((input, key) => {
    composer.handleKey(input, key);
  });
  return (
    <Composer
      state={composer.state}
      width={WIDTH}
      onCaret={composer.setCursor}
      {...(props.maxRows === undefined ? {} : { maxRows: props.maxRows })}
    />
  );
}

async function mount(maxRows?: number) {
  const setup = await testRender(
    <box flexDirection="column" width={WIDTH} height={HEIGHT}>
      <Harness {...(maxRows === undefined ? {} : { maxRows })} />
    </box>,
    { width: WIDTH, height: HEIGHT },
  );
  await setup.flush();
  return setup;
}

async function drive(
  setup: Awaited<ReturnType<typeof mount>>,
  action: () => Promise<void> | void,
): Promise<void> {
  await act(async () => {
    await action();
    await setup.flush();
  });
  await setup.flush();
}

function visible(frame: string): string[] {
  return LINES.filter((line) => new RegExp(`${line}\\b`).test(frame));
}

describe("scrolling the composer", () => {
  it("opens at the caret, showing the end of the draft", async () => {
    const setup = await mount();
    try {
      const shown = visible(setup.captureCharFrame());
      expect(shown).toContain("line 12");
      expect(shown).not.toContain("line 1");
      // Eight rows of a twelve-line draft, and it says how many it is keeping back.
      expect(setup.captureCharFrame()).toContain("↑ 4 more");
    } finally {
      setup.renderer.destroy();
    }
  });

  it("scrolls up on the wheel without moving the caret", async () => {
    const setup = await mount();
    try {
      await drive(setup, () => setup.mockMouse.scroll(4, 2, "up"));
      const frame = setup.captureCharFrame();
      expect(visible(frame)).toContain("line 4");
      // Three rows above the window instead of four: it moved by exactly one report.
      expect(frame).toContain("↑ 3 more");
      expect(frame).toContain("↓ 1 more");
    } finally {
      setup.renderer.destroy();
    }
  });

  it("grows to the rows it is given rather than a fixed eight", async () => {
    // Twelve lines against a twelve-row ceiling: the whole draft fits, so nothing is held back.
    const setup = await mount(12);
    try {
      const frame = setup.captureCharFrame();
      expect(visible(frame)).toHaveLength(12);
      expect(frame).not.toContain("more");
    } finally {
      setup.renderer.destroy();
    }
  });

  it("places the caret where it is clicked", async () => {
    const setup = await mount(12);
    try {
      // Row 3 of the box is the third line of the draft; column 6 is inside `line 3` — one border, one
      // pad and the two-column gutter in from the left edge, so column 4 of the frame is character 0.
      await drive(setup, () => setup.mockMouse.click(4 + 2, 3));
      // Typing lands where the click put the caret, not where it was.
      await drive(setup, () => setup.mockInput.typeText("X"));
      const frame = setup.captureCharFrame();
      expect(frame).toContain("liXne 3");
    } finally {
      setup.renderer.destroy();
    }
  });

  it("ignores a click on its own border", async () => {
    const setup = await mount(12);
    try {
      await drive(setup, () => setup.mockMouse.click(2, 0));
      await drive(setup, () => setup.mockInput.typeText("X"));
      // The caret never moved, so the draft still ends where it started.
      expect(setup.captureCharFrame()).toContain("line 12X");
    } finally {
      setup.renderer.destroy();
    }
  });

  it("snaps back to the caret on the next keystroke", async () => {
    const setup = await mount();
    try {
      await drive(setup, async () => {
        await setup.mockMouse.scroll(4, 2, "up");
        await setup.mockMouse.scroll(4, 2, "up");
      });
      expect(setup.captureCharFrame()).toContain("↓ 2 more");

      await drive(setup, () => setup.mockInput.typeText("!"));
      const frame = setup.captureCharFrame();
      expect(frame).toContain("line 12!");
      expect(frame).not.toContain("↓");
    } finally {
      setup.renderer.destroy();
    }
  });
});
