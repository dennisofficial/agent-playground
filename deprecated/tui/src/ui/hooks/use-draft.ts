import type { TextareaRenderable } from "@opentui/core";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  imageToken,
  imagesInDraft,
  nextOrdinal,
  type DraftImage,
} from "../../domain/draft-images.js";

/**
 * The prompt composer's draft.
 *
 * Where `useComposer` OWNS an `EditorState` and hands it to a component to draw, this owns nothing:
 * the text lives in the native buffer behind `<Composer>`, and this is the handle onto it. The
 * mirrored `value` exists because a render has to be able to ask how long the draft is — the hint
 * line measures it, the veto asks whether it is empty, and the page writes it back to `store.draft`
 * — and reaching into a renderable during render would read a value React has no reason to have
 * re-rendered for.
 *
 * The buffer is the truth and the mirror follows it, never the other way round. Nothing here sets
 * text without going through the buffer first.
 */
export type DraftControls = {
  /** The draft's text as of the last change. */
  value: string;
  /** Bound by `<Composer>` on mount; null before it. */
  editor: React.RefObject<TextareaRenderable | null>;
  /** Replace the draft — a slash command completing, a queued steer being restored. Undoable. */
  setValue: (value: string) => void;
  clear: () => void;
  /** Type at the caret, as if the keys had been pressed. */
  insert: (chunk: string) => void;
  /**
   * Every image pasted into this draft, whether or not its token survives — `pending` is the list
   * that still counts. Kept whole so a token deleted and retyped still finds its picture.
   */
  images: readonly DraftImage[];
  /** Put an image in the draft: it takes the next number and its token is typed at the caret. */
  addImage: (image: Omit<DraftImage, "ordinal">) => DraftImage;
  /** The images this draft still refers to, in the order it mentions them. What gets sent. */
  pending: () => readonly DraftImage[];
  /**
   * Is the caret on the draft's first VISUAL row — the row a person sees?
   *
   * The one question the page cannot answer from the text alone, and the one `↑` turns on. Read
   * live rather than mirrored: it changes on every caret move, and a stale answer here is the old
   * bug wearing a new hat.
   */
  isCaretAtTop: () => boolean;
  /** What `<Composer>` calls when the buffer changes. Not for callers. */
  sync: (text: string) => void;
  /** The text the composer opens with — applied once, by the renderable's constructor. */
  initial: string;
};

export function useDraft(initial = ""): DraftControls {
  const [value, setValue] = useState(initial);
  const [images, setImages] = useState<readonly DraftImage[]>([]);
  const editor = useRef<TextareaRenderable | null>(null);

  const sync = useCallback((text: string) => setValue(text), []);

  const replace = useCallback((next: string) => {
    const target = editor.current;
    // `replaceText` rather than `setText`: it keeps the undo history, so a slash command completing
    // is a thing you can take back rather than a wall.
    if (target) {
      target.replaceText(next);
      target.cursorOffset = next.length;
    }
    setValue(next);
  }, []);

  const insert = useCallback((chunk: string) => {
    const target = editor.current;
    if (!target) return;
    target.insertText(chunk);
    setValue(target.plainText);
  }, []);

  const latestImages = useRef(images);
  latestImages.current = images;

  // Clearing discards the pictures too. Their tokens went with the words, and an image list that
  // outlived the draft that referred to it would attach itself to the NEXT message.
  const clear = useCallback(() => {
    replace("");
    latestImages.current = [];
    setImages([]);
  }, [replace]);

  const addImage = useCallback(
    (image: Omit<DraftImage, "ordinal">): DraftImage => {
      const placed: DraftImage = {
        ...image,
        ordinal: nextOrdinal(latestImages.current),
      };
      const next = [...latestImages.current, placed];
      latestImages.current = next;
      setImages(next);

      const target = editor.current;
      if (target) {
        // A trailing space, because the token is a word in a sentence and the next thing typed
        // should not run into it.
        target.insertText(`${imageToken(placed.ordinal)} `);
        setValue(target.plainText);
      }
      return placed;
    },
    [],
  );

  // Read from the buffer rather than the mirror: `pending()` is called at SEND, one keystroke after
  // the last change, and a mirror a render behind would drop an image whose token was just typed.
  const pending = useCallback((): readonly DraftImage[] => {
    const text = editor.current?.plainText ?? "";
    return imagesInDraft(text, latestImages.current);
  }, []);

  const isCaretAtTop = useCallback((): boolean => {
    const target = editor.current;
    // No editor yet means no draft to be inside of, so ↑ belongs to the page.
    if (!target) return true;
    // `visualRow` is VIEWPORT-relative, so the document's first row is row zero of an unscrolled
    // viewport — and both halves matter: a scrolled box can show row zero of its own window while
    // the draft continues above it.
    return target.visualCursor.visualRow === 0 && target.scrollY === 0;
  }, []);

  // `initial` is deliberately captured once. It is the seed for a buffer that then owns itself; a
  // changing prop would fight the user's typing for control of the text.
  const seed = useRef(initial);

  return useMemo(
    () => ({
      value,
      editor,
      setValue: replace,
      clear,
      insert,
      images,
      addImage,
      pending,
      isCaretAtTop,
      sync,
      initial: seed.current,
    }),
    [value, replace, clear, insert, images, addImage, pending, isCaretAtTop, sync],
  );
}
