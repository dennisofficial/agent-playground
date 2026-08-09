import { testRender } from "@opentui/react/test-utils";
import { beforeEach, describe, expect, it, mock } from "bun:test";
import React, { act } from "react";

const copies: string[] = [];
let succeeds = true;

void mock.module("../clipboard.js", () => ({
  copyToClipboard: (_renderer: unknown, text: string) => {
    copies.push(text);
    return succeeds;
  },
}));

// Imported after the mock is registered, so the module under test binds to it.
const { Composer } = await import("../components/composer.js");
const { CopyNoticeProvider, useCopyOnSelect } =
  await import("../copy-on-select.js");
const { EMPTY_EDITOR } = await import("../../domain/text-editor.js");

const WIDTH = 40;
const HEIGHT = 8;

function Harness(): React.ReactNode {
  const notice = useCopyOnSelect();
  return (
    <CopyNoticeProvider notice={notice}>
      <box flexDirection="column" width={WIDTH} height={HEIGHT}>
        <text>alpha beta gamma</text>
        <text>delta epsilon</text>
        <Composer state={EMPTY_EDITOR} width={WIDTH} />
      </box>
    </CopyNoticeProvider>
  );
}

async function mount() {
  const setup = await testRender(<Harness />, { width: WIDTH, height: HEIGHT });
  await setup.flush();
  return setup;
}

/** `act`, because the notice is `setState` from a renderer event — see `composer-paste.spec`. */
async function drag(
  setup: Awaited<ReturnType<typeof mount>>,
  from: [number, number],
  to: [number, number],
): Promise<void> {
  await act(async () => {
    await setup.mockMouse.drag(from[0], from[1], to[0], to[1]);
    await setup.flush();
  });
  await setup.flush();
}

beforeEach(() => {
  copies.length = 0;
  succeeds = true;
});

describe("copy on select", () => {
  it("puts the selection on the clipboard when the drag ends", async () => {
    const setup = await mount();
    try {
      await drag(setup, [0, 0], [10, 0]);

      // Once, not once per mouse report: a drag emits a selection event for every cell it crosses.
      expect(copies.length).toBe(1);
      expect(copies[0]).toContain("alpha");

      // And the composer says so, in its own border, without costing the layout a row.
      const lines = setup.captureCharFrame().split("\n");
      expect(
        lines.some((line) => line.includes("copied") && line.includes("╮")),
      ).toBe(true);
    } finally {
      setup.renderer.destroy();
    }
  });

  it("copies each new selection, and nothing on a bare click", async () => {
    const setup = await mount();
    try {
      await drag(setup, [0, 0], [10, 0]);
      await drag(setup, [0, 1], [8, 1]);
      expect(copies.length).toBe(2);
      expect(copies[1]).toContain("delta");

      // A click clears the selection through the same event. Copying that empty string would destroy
      // what the user had on their clipboard — the one loss they cannot undo.
      await act(async () => {
        await setup.mockMouse.click(2, 0);
        await setup.flush();
      });
      expect(copies.length).toBe(2);
    } finally {
      setup.renderer.destroy();
    }
  });

  it("reports a clipboard it could not reach rather than claiming success", async () => {
    succeeds = false;
    const setup = await mount();
    try {
      await drag(setup, [0, 0], [10, 0]);
      const frame = setup.captureCharFrame();
      expect(frame).toContain("unavailable");
      expect(frame).not.toContain("copied");
    } finally {
      setup.renderer.destroy();
    }
  });
});
