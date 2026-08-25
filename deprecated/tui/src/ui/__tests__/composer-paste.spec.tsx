import { testRender } from "@opentui/react/test-utils";
import { describe, expect, it } from "bun:test";
import React, { act } from "react";
import { Composer } from "../components/composer.js";
import { LineInput } from "../components/line-input.js";
import { useComposer, type ComposerOptions } from "../hooks/use-composer.js";
import { useDraft } from "../hooks/use-draft.js";

const WIDTH = 44;

/**
 * ⌘V never arrives as keystrokes: the renderer turns bracketed paste on and the clipboard lands as
 * ONE event on its own channel. Both boxes have to answer it — the prompt composer through the
 * native buffer's own paste handler, the one-line input through `usePaste`.
 */

function DraftHarness(): React.ReactNode {
  const draft = useDraft("");
  return <Composer draft={draft} width={WIDTH} />;
}

function LineHarness(props: { options?: ComposerOptions }): React.ReactNode {
  const composer = useComposer("", props.options ?? {});
  return <LineInput state={composer.state} width={WIDTH} />;
}

async function paste(node: React.ReactNode, text: string) {
  const setup = await testRender(
    <box flexDirection="column" width={WIDTH} height={12}>
      {node}
    </box>,
    { width: WIDTH, height: 12 },
  );
  await act(async () => {
    await setup.flush();
  });
  // Inside `act`, or the commit from the paste handler never reaches the buffer — the harness
  // renders in `act`, so an event dispatched outside it lands after the frame it should have changed.
  await act(async () => {
    await setup.mockInput.pasteBracketedText(text);
    await setup.flush();
  });
  await setup.flush();
  return setup;
}

describe("pasting into the prompt composer", () => {
  it("takes a multi-line paste as lines, not as a submit", async () => {
    const setup = await paste(<DraftHarness />, "first line\nsecond line");
    try {
      const frame = setup.captureCharFrame();
      expect(frame).toContain("first line");
      expect(frame).toContain("second line");
    } finally {
      setup.renderer.destroy();
    }
  });
});

describe("pasting into a one-line field", () => {
  it("flattens the paste", async () => {
    // The case that matters: an OAuth code copied out of a browser arrives with a trailing newline,
    // and a filter holding an invisible `\n` matches nothing with no way to see why.
    const setup = await paste(
      <LineHarness options={{ singleLine: true }} />,
      "code#state\n",
    );
    try {
      const lines = setup.captureCharFrame().split("\n");
      const row = lines.findIndex((line) => line.includes("code#state"));
      expect(row).toBeGreaterThanOrEqual(0);
      // The row under it is the box's own border, not a second line of text.
      expect(lines[row + 1] ?? "").not.toContain("code");
    } finally {
      setup.renderer.destroy();
    }
  });
});
