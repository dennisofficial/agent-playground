import type { KeyBinding } from "@opentui/core";
import React, { useCallback, useLayoutEffect, useState } from "react";
import type { DraftControls } from "../hooks/use-draft.js";
import { paintImageChips } from "./image-chips.js";
import { useCopyNotice } from "../copy-on-select.js";
import { theme } from "../theme.js";

/**
 * The box you write a prompt in — OpenTUI's native editor, wearing Atlas's chrome.
 *
 * It is native because the caret has to move over the rows a person can SEE. The composer this
 * replaced moved over `\n`-separated logical lines while drawing wrapped ones, so `↑` in a wrapped
 * paragraph did nothing at all and `↑` in a two-paragraph draft jumped three rows. Underneath is a
 * Zig rope buffer whose `move-up` is `moveUpVisual()`, and with it come selection, undo/redo and
 * grapheme-correct movement — none of which the pure editor had any path to.
 *
 * The page keeps its keyboard by VETO rather than by first refusal: OpenTUI runs global key handlers
 * before the focused renderable's and skips the renderable when one calls `preventDefault()`, so
 * `use-conversation-keys` claims what it wants and everything else reaches the editor untouched.
 * See `domain/composer-veto.ts`.
 *
 * `line-input.tsx` is the OTHER box — one line, in a list page's footer, still on the pure editor
 * because a filter never wraps and `↑` there belongs to the list.
 */

const DEFAULT_MAX_ROWS = 8;

export function composerRows(height: number): number {
  return Math.max(DEFAULT_MAX_ROWS, Math.floor(height / 2) - 2);
}

/**
 * What Atlas adds to the native keymap, and why each one is missing from it.
 *
 * Bindings are looked up by an exact `name:ctrl:shift:meta:super` key, so a default binding on the
 * bare key does not answer a modified one — which is why OpenTUI's own defaults spell out
 * `shift+backspace` and `shift+delete` by hand.
 *
 * **Return.** The default keymap has no `shift+⏎`, and unbound it does NOTHING: it falls through to
 * the printable path, where `\r` is under charcode 32 and is dropped on the floor. `meta+⏎` is
 * remapped off its default `submit` because in Atlas the PAGE owns submit, on a plain `⏎`, and every
 * modified Return is a newline.
 *
 * **⌘⌫.** The macOS rub-out-the-line gesture, and the one hole in the defaults' otherwise complete
 * set of ⌘ bindings — they ship `⌘←`/`⌘→` and `⌘↑`/`⌘↓`, but nothing on backspace, so ⌘⌫ fell
 * through to the plain `backspace` binding and ate a single character. ⌥⌫ stays
 * `delete-word-backward`, which is what macOS does with it everywhere else.
 *
 * `delete-to-line-start` is the LOGICAL line, where `⌘←` is the visual one. It is the only
 * delete-leftwards action the editor exposes, and the difference shows only in a wrapped paragraph
 * — where rubbing out to the paragraph's start is the likelier intent anyway.
 *
 * ⌘ reaches a terminal application only under the kitty keyboard protocol, which reports it as
 * `super`. The renderer asks for that protocol by default; a terminal that does not speak it sends
 * a bare `\x7f` and gets the ordinary backspace, which is the right thing to degrade to.
 */
const ATLAS_BINDINGS: KeyBinding[] = [
  { name: "return", shift: true, action: "newline" },
  { name: "return", ctrl: true, action: "newline" },
  { name: "return", meta: true, action: "newline" },
  { name: "backspace", super: true, action: "delete-to-line-start" },
];

export function Composer(props: {
  draft: DraftControls;
  placeholder?: string;
  width: number;
  maxRows?: number;
  focused?: boolean;
}): React.ReactNode {
  const copied = useCopyNotice();
  const maxRows = props.maxRows ?? DEFAULT_MAX_ROWS;
  const [metrics, setMetrics] = useState({ rows: 1, total: 1 });

  const editor = props.draft.editor;
  const sync = props.draft.sync;

  /**
   * Grow to the draft, up to the cap.
   *
   * A renderable takes a height and KEEPS it, where the old composer grew for free by slicing a list
   * of `<text>` rows. Measured against a width we compute ourselves, because the two line-count
   * getters both lie at the moment we need them: `virtualLineCount` reports the VIEWPORT's wrapped
   * lines, so feeding it back into the height pegs the box at whatever it already was, and
   * `getTotalVirtualLineCount()` answers for the width yoga has already applied — which, on the pass
   * that decides the first frame, is not yet the real one.
   */
  const measure = useCallback(() => {
    const target = editor.current;
    if (!target) return;
    const measured = target.editorView.measureForDimensions(
      textWidth(props.width),
      UNBOUNDED,
    );
    const total = Math.max(1, measured?.lineCount ?? 1);
    const rows = Math.min(total, maxRows);
    // Only when it actually changed. `measure` runs on every caret move, and a fresh object each
    // time would re-render the composer for every arrow key — the height is the same on all but a
    // handful of them.
    setMetrics((current) =>
      current.rows === rows && current.total === total
        ? current
        : { rows, total },
    );
  }, [editor, maxRows, props.width]);

  useLayoutEffect(() => {
    const target = editor.current;
    if (!target) return;
    // A restored draft opens with the caret at its END, where `fromText` has always put it.
    // `initialValue` leaves it at offset zero, which puts the next keystroke in front of the draft.
    target.cursorOffset = target.plainText.length;
    measure();
  }, [editor, measure]);

  const images = props.draft.images;
  const handleChange = useCallback(() => {
    const target = editor.current;
    if (!target) return;
    sync(target.plainText);
    measure();
    // After the text changed, because every offset before a token moves with it.
    paintImageChips(target, images);
  }, [editor, images, measure, sync]);

  // And whenever the LIST changes without the text doing so — a paste adds an image and its token
  // in one go, and the mark for the new token has to land after the buffer holds it.
  useLayoutEffect(
    () => paintImageChips(editor.current, images),
    [editor, images],
  );

  return (
    <box
      flexDirection="column"
      width={props.width}
      flexShrink={0}
      borderStyle="rounded"
      borderColor={theme.dim}
      paddingX={1}
      {...(copied
        ? {
            title: ` ${copied.text} `,
            titleColor: copied.ok ? theme.okBright : theme.warn,
          }
        : {})}
      titleAlignment="right"
    >
      <box flexDirection="row">
        {/* The `> ` marker, beside the editor rather than in front of each line: the buffer owns its
            own rows now. `flexShrink={0}`, or a wide draft squeezes the marker out of existence. */}
        <text fg={theme.dim} flexShrink={0}>
          {"> "}
        </text>
        <textarea
          ref={editor as never}
          initialValue={props.draft.initial}
          focused={props.focused !== false}
          flexGrow={1}
          wrapMode="word"
          height={metrics.rows}
          textColor={theme.userFg}
          cursorColor={theme.caretBg}
          keyBindings={ATLAS_BINDINGS}
          {...(props.placeholder ? { placeholder: props.placeholder } : {})}
          placeholderColor={theme.dim}
          onContentChange={handleChange}
          onCursorChange={measure}
        />
      </box>

      {/* A draft taller than the box must say so, or the rows below the fold read as lost text.
          WITHOUT the counts the old composer printed: `scrollY` keeps its offset across a height
          change and does not settle inside the cursor event that caused the scroll, so `↑ 3 more`
          is reliably wrong by a row or two. The editor owns its scrolling; the chrome only says
          that there is more. */}
      {metrics.total > metrics.rows ? (
        <text fg={theme.dim}>{`  ⋯ ${metrics.total} rows, ${metrics.rows} shown`}</text>
      ) : null}
    </box>
  );
}

/** Two border columns, two padding columns, and the two-column `> ` marker. */
function textWidth(width: number): number {
  return Math.max(8, width - 6);
}

/** Tall enough that the measurement is never the thing doing the clipping. */
const UNBOUNDED = 10_000;
