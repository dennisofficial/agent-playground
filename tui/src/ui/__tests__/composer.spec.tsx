import type { TextareaRenderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { describe, expect, it } from "bun:test";
import React, { act } from "react";
import { EPageClaim, pageClaim } from "../../domain/composer-veto.js";
import { Composer } from "../components/composer.js";
import { useDraft, type DraftControls } from "../hooks/use-draft.js";
import { useInput } from "../hooks/use-input.js";

const WIDTH = 40;
const HEIGHT = 20;

/**
 * One logical line, no newline anywhere, long enough to wrap several times. This is the shape the
 * old composer could not move through: `moveUp` looked for a `\n` above the caret, found none, and
 * reported that it could not move — so `↑` in a paragraph like this did nothing at all.
 */
const PARAGRAPH =
  "the quick brown fox jumps over the lazy dog and then keeps running well past the right edge of this box";

type Handle = { draft: DraftControls; editor: TextareaRenderable | null };

/** The harness IS the page: keys reach a composer through one, never through the component. */
function Harness(props: {
  seed?: string;
  maxRows?: number;
  onHandle: (handle: Handle) => void;
  onSubmit?: () => void;
}): React.ReactNode {
  const draft = useDraft(props.seed ?? "");
  props.onHandle({ draft, editor: draft.editor.current });

  useInput((_input, key) => {
    const claim = pageClaim(
      {
        name: key.name,
        ctrl: key.ctrl,
        meta: key.meta,
        shift: key.shift,
        super: key.super,
      },
      {
        empty: draft.value.length === 0,
        caretAtTop: draft.isCaretAtTop(),
        overlayOpen: false,
      },
    );
    if (claim === null) return;
    key.preventDefault();
    if (claim === EPageClaim.submit) props.onSubmit?.();
  });

  return (
    <Composer
      draft={draft}
      width={WIDTH}
      {...(props.maxRows === undefined ? {} : { maxRows: props.maxRows })}
    />
  );
}

async function mount(options: {
  seed?: string;
  maxRows?: number;
  onSubmit?: () => void;
}) {
  let handle: Handle = { draft: null as never, editor: null };
  const setup = await testRender(
    <box flexDirection="column" width={WIDTH} height={HEIGHT}>
      <Harness
        {...options}
        onHandle={(next) => {
          handle = next;
        }}
      />
    </box>,
    { width: WIDTH, height: HEIGHT, kittyKeyboard: true, otherModifiersMode: true },
  );
  // The composer measures itself in a layout effect and commits the result, so the first frame
  // settles with a state update of its own — inside `act`, or React reports it as an escaped one.
  await act(async () => {
    await setup.flush();
  });
  return {
    setup,
    editor: (): TextareaRenderable =>
      handle.draft.editor.current as TextareaRenderable,
    draft: (): DraftControls => handle.draft,
  };
}

/** `act`, or a key dispatched outside it lands after the frame it should have changed. */
async function press(
  setup: Awaited<ReturnType<typeof mount>>["setup"],
  action: () => void,
): Promise<void> {
  await act(async () => {
    action();
    await setup.flush();
  });
  await setup.flush();
}

describe("moving the caret through a wrapped draft", () => {
  it("walks ONE visible row per ↑, in a paragraph with no newline in it", async () => {
    const { setup, editor } = await mount({ seed: PARAGRAPH });
    try {
      const start = editor().visualCursor;
      expect(start.visualRow).toBeGreaterThan(0); // the draft wrapped, or this proves nothing

      await press(setup, () => setup.mockInput.pressArrow("up"));

      expect(editor().visualCursor.visualRow).toBe(start.visualRow - 1);
      // And the caret really moved through the text, rather than the view scrolling under it.
      expect(editor().cursorOffset).toBeLessThan(start.offset);
    } finally {
      setup.renderer.destroy();
    }
  });

  it("comes back to the column it left when ↑ then ↓ crosses a short row", async () => {
    const { setup, editor } = await mount({ seed: `${PARAGRAPH}\nshort\n${PARAGRAPH}` });
    try {
      const before = editor().cursorOffset;
      await press(setup, () => setup.mockInput.pressArrow("up"));
      await press(setup, () => setup.mockInput.pressArrow("up"));
      await press(setup, () => setup.mockInput.pressArrow("down"));
      await press(setup, () => setup.mockInput.pressArrow("down"));
      expect(editor().cursorOffset).toBe(before);
    } finally {
      setup.renderer.destroy();
    }
  });

  // The page only gets ↑ once the caret genuinely has no row above it — the condition the whole
  // change turns on. `isCaretAtTop` is the question `use-conversation-keys` asks.
  it("reports the caret as past the top only on the first visible row", async () => {
    const { setup, editor, draft } = await mount({ seed: PARAGRAPH });
    try {
      const rows = editor().visualCursor.visualRow;
      expect(rows).toBeGreaterThan(0);

      for (let index = 0; index < rows; index++) {
        expect(draft().isCaretAtTop()).toBe(false);
        await press(setup, () => setup.mockInput.pressArrow("up"));
      }
      expect(draft().isCaretAtTop()).toBe(true);
    } finally {
      setup.renderer.destroy();
    }
  });
});

describe("the box's height", () => {
  it("is one row for a one-line draft, not the cap", async () => {
    const { setup } = await mount({ seed: "one short line", maxRows: 8 });
    try {
      expect(borderRows(setup.captureCharFrame())).toBe(3); // top, one row, bottom
    } finally {
      setup.renderer.destroy();
    }
  });

  it("stops at the cap and says how much is hidden", async () => {
    const { setup } = await mount({ seed: PARAGRAPH, maxRows: 2 });
    try {
      const frame = setup.captureCharFrame();
      expect(frame).toContain("2 shown");
    } finally {
      setup.renderer.destroy();
    }
  });
});

describe("Return", () => {
  it("inserts a newline when shifted — the binding the native keymap does not ship", async () => {
    const { setup, editor } = await mount({ seed: "first" });
    try {
      await press(setup, () => setup.mockInput.pressEnter({ shift: true }));
      await press(setup, () => setup.mockInput.typeText("second"));
      expect(editor().plainText).toBe("first\nsecond");
    } finally {
      setup.renderer.destroy();
    }
  });

  it("submits when plain, and never reaches the buffer", async () => {
    let submits = 0;
    const { setup, editor } = await mount({
      seed: "a draft",
      onSubmit: () => {
        submits += 1;
      },
    });
    try {
      await press(setup, () => setup.mockInput.pressEnter());
      expect(submits).toBe(1);
      // The claim has to STOP the key, or ⏎ would send the draft and type into it at once.
      expect(editor().plainText).toBe("a draft");
    } finally {
      setup.renderer.destroy();
    }
  });
});

describe("⌘⌫", () => {
  it("rubs out everything to the left of the caret on its line", async () => {
    const { setup, editor } = await mount({ seed: "first line\nsecond line" });
    try {
      await press(setup, () => setup.mockInput.pressBackspace({ super: true }));
      // The caret opens at the end of the draft, so the second line goes and the first stays. The
      // editor takes the newline with it — an emptied line and the caret at the end of the one above
      // it are the same place, and this is what its own ctrl+u does too.
      expect(editor().plainText).toBe("first line");
    } finally {
      setup.renderer.destroy();
    }
  });

  it("keeps what is to the RIGHT of the caret", async () => {
    const { setup, editor } = await mount({ seed: "keep this" });
    try {
      await press(setup, () => setup.mockInput.pressArrow("left"));
      await press(setup, () => setup.mockInput.pressArrow("left"));
      await press(setup, () => setup.mockInput.pressArrow("left"));
      await press(setup, () => setup.mockInput.pressBackspace({ super: true }));
      expect(editor().plainText).toBe("his");
    } finally {
      setup.renderer.destroy();
    }
  });

  it("leaves ⌥⌫ deleting a word, and a bare ⌫ a character", async () => {
    const { setup, editor } = await mount({ seed: "one two" });
    try {
      await press(setup, () => setup.mockInput.pressBackspace({ meta: true }));
      expect(editor().plainText).toBe("one ");
      await press(setup, () => setup.mockInput.pressBackspace());
      expect(editor().plainText).toBe("one");
    } finally {
      setup.renderer.destroy();
    }
  });
});

function borderRows(frame: string): number {
  return frame.split("\n").filter((line) => /[╭│╰]/.test(line)).length;
}
