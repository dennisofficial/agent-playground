import { testRender } from "@opentui/react/test-utils";
import { describe, expect, it } from "bun:test";
import React, { act } from "react";
import { EImageDelivery } from "../../domain/image-limits.js";
import { Composer } from "../components/composer.js";
import { useDraft, type DraftControls } from "../hooks/use-draft.js";

/**
 * The `[Image #N]` token, painted as a chip.
 *
 * Worth a test of its own because it rides on an API OpenTUI marks as provisional ("simulating
 * extmarks … will move to a real native implementation"), and because the `virtual` flag that makes
 * the chip ATOMIC is not documented as doing that — it was found by driving it. If a version bump
 * silently drops that behaviour, a half-deleted token stops matching `imagesInDraft` and the picture
 * quietly stops being sent. This is the test that catches it.
 */

const WIDTH = 44;

async function draftWithImage() {
  let draft: DraftControls = null as never;

  function Harness(): React.ReactNode {
    draft = useDraft("");
    return <Composer draft={draft} width={WIDTH} />;
  }

  const setup = await testRender(
    <box flexDirection="column" width={WIDTH} height={10}>
      <Harness />
    </box>,
    { width: WIDTH, height: 10, kittyKeyboard: true, otherModifiersMode: true },
  );
  await act(async () => {
    await setup.flush();
  });
  await act(async () => {
    draft.setValue("look at this: ");
    draft.addImage({
      path: "/tmp/x.png",
      mediaType: "image/png",
      byteLength: 10,
      delivery: EImageDelivery.inline,
    });
    await setup.flush();
  });
  await act(async () => {
    await setup.flush();
  });

  return { setup, draft, editor: () => draft.editor.current! };
}

describe("the image token in the draft", () => {
  it("is marked over exactly the token's characters", async () => {
    const { setup, editor } = await draftWithImage();
    try {
      const marks = editor().extmarks.getAll();
      expect(marks).toHaveLength(1);
      // "look at this: " is 14 characters; the token is 10 more.
      expect(marks[0]).toMatchObject({ start: 14, end: 24, virtual: true });
    } finally {
      setup.renderer.destroy();
    }
  });

  it("is stepped OVER by an arrow key, not walked into", async () => {
    const { setup, draft, editor } = await draftWithImage();
    try {
      editor().cursorOffset = draft.value.length;
      await act(async () => {
        setup.mockInput.pressArrow("left");
        await setup.flush();
      });
      // One press lands on the token's trailing edge...
      expect(editor().cursorOffset).toBe(24);
      await act(async () => {
        setup.mockInput.pressArrow("left");
        await setup.flush();
      });
      // ...and the next clears the whole thing, rather than stopping inside it at 23.
      expect(editor().cursorOffset).toBe(13);
    } finally {
      setup.renderer.destroy();
    }
  });

  /**
   * The failure this exists to prevent: one backspace eating the `]` and leaving `[Image #1`, which
   * matches nothing, so the picture stops being sent with no sign that anything changed.
   */
  it("is removed whole by one backspace", async () => {
    const { setup, editor } = await draftWithImage();
    try {
      editor().cursorOffset = 24;
      await act(async () => {
        setup.mockInput.pressBackspace();
        await setup.flush();
      });
      expect(editor().plainText).toBe("look at this:  ");
    } finally {
      setup.renderer.destroy();
    }
  });
});
