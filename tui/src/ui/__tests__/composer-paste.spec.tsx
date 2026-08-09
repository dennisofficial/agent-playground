import { testRender } from "@opentui/react/test-utils";
import { describe, expect, it } from "bun:test";
import React, { act } from "react";
import { Composer } from "../components/composer.js";
import { useComposer, type ComposerOptions } from "../hooks/use-composer.js";

const WIDTH = 44;

function Harness(props: { options?: ComposerOptions }): React.ReactNode {
  const composer = useComposer("", props.options ?? {});
  return <Composer state={composer.state} width={WIDTH} />;
}

async function paste(text: string, options?: ComposerOptions) {
  const setup = await testRender(
    <box flexDirection="column" width={WIDTH} height={12}>
      <Harness {...(options ? { options } : {})} />
    </box>,
    { width: WIDTH, height: 12 },
  );
  await setup.flush();
  // Inside `act`, or the state commit from the paste handler never reaches the buffer — the harness
  // renders in `act`, so an event dispatched outside it lands after the frame it should have changed.
  await act(async () => {
    await setup.mockInput.pasteBracketedText(text);
    await setup.flush();
  });
  await setup.flush();
  return setup;
}

describe("pasting into the composer", () => {
  it("takes a multi-line paste as lines, not as a submit", async () => {
    const setup = await paste("first line\nsecond line");
    try {
      const frame = setup.captureCharFrame();
      expect(frame).toContain("first line");
      expect(frame).toContain("second line");
    } finally {
      setup.renderer.destroy();
    }
  });

  it("flattens a paste into a one-line field", async () => {
    // The case that matters: an OAuth code copied out of a browser arrives with a trailing newline,
    // and a filter holding an invisible `\n` matches nothing with no way to see why.
    const setup = await paste("code#state\n", { singleLine: true });
    try {
      const lines = setup.captureCharFrame().split("\n");
      const row = lines.findIndex((line) => line.includes("code#state"));
      expect(row).toBeGreaterThanOrEqual(0);
      // One text row inside the border: a swallowed newline would have opened a second.
      expect(lines[row + 1]).toContain("╰");
    } finally {
      setup.renderer.destroy();
    }
  });

  it("strips escape sequences that came with the copy", async () => {
    const setup = await paste("\u001b[31mred\u001b[0m text");
    try {
      const frame = setup.captureCharFrame();
      expect(frame).toContain("red text");
      expect(frame).not.toContain("[31m");
    } finally {
      setup.renderer.destroy();
    }
  });
});
