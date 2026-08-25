import { SyntaxStyle, type TextareaRenderable } from "@opentui/core";
import { imageToken, type DraftImage } from "../../domain/draft-images.js";
import { onPaletteChange } from "../palette-store.js";
import { theme } from "../theme.js";

/**
 * Paints every `[Image #N]` token in the draft as a chip.
 *
 * The token is short and literal in the buffer on purpose — the draft has to stay a plain string
 * all the way through `store.draft` and out to the wire, and the manifest the model reads is
 * assembled at send (`renderPrompt`), not typed by the user. So what changes here is only how those
 * characters LOOK: a person should see something they pasted, not punctuation they might edit.
 *
 * Extmarks rather than a plain highlight, and `virtual: true` rather than a plain extmark — that
 * flag is what makes the chip ATOMIC, and it is load-bearing rather than decorative. Without it the
 * controller's wrapped movement does nothing useful: arrows walk into the token a character at a
 * time and one backspace eats the `]`, leaving `[Image #1` behind. A half-token matches nothing in
 * `imagesInDraft`, so the picture silently stops being sent. With it, arrows step over the whole
 * token and backspace takes all ten characters at once. Measured, not assumed — the flag is not
 * documented as doing this, and `ui/__tests__/image-chip.spec.tsx` is what will catch it changing.
 *
 * The API is marked unstable upstream ("simulating extmarks … will move to a real native
 * implementation"), so every call here is guarded and a failure degrades to an unstyled token
 * rather than taking the composer with it.
 */

const STYLE_NAME = "atlas.image-token";
const TYPE_NAME = "atlas.image";

/** Registered once per editor; the id is the handle every mark refers back to. */
type ChipStyle = { styleId: number; typeId: number };

let registered = new WeakMap<TextareaRenderable, ChipStyle>();

/**
 * A chip's colours are compiled into a `SyntaxStyle` and pushed into the editor's NATIVE buffer, so
 * they outlive any re-render — the chip on a composer you have already used would keep the old
 * accent for the life of that editor.
 *
 * A fresh WeakMap rather than `.delete()` per key: entries are keyed by editor and a WeakMap cannot
 * be enumerated, so replacing the map wholesale is the only way to forget all of them. The old one
 * is garbage once nothing points at it.
 */
onPaletteChange(() => {
  registered = new WeakMap<TextareaRenderable, ChipStyle>();
});

function ensureStyle(editor: TextareaRenderable): ChipStyle | null {
  const existing = registered.get(editor);
  if (existing) return existing;

  try {
    const style = SyntaxStyle.fromStyles({
      [STYLE_NAME]: { fg: theme.caretFg, bg: theme.accent },
    });
    const styleId = style.getStyleId(STYLE_NAME);
    if (styleId === null) return null;

    editor.editBuffer.setSyntaxStyle(style);
    const typeId = editor.extmarks.registerType(TYPE_NAME);

    const chip = { styleId, typeId };
    registered.set(editor, chip);
    return chip;
  } catch {
    return null;
  }
}

/**
 * Re-paint the chips for the draft as it stands.
 *
 * Cleared and rebuilt rather than diffed: a token's offsets move on every keystroke before it, the
 * marks are cheap, and there are never more than a handful. Correct beats clever on something that
 * runs on every content change.
 */
export function paintImageChips(
  editor: TextareaRenderable | null,
  images: readonly DraftImage[],
): void {
  if (!editor) return;

  const chip = ensureStyle(editor);
  if (!chip) return;

  try {
    for (const mark of editor.extmarks.getAllForTypeId(chip.typeId)) {
      editor.extmarks.delete(mark.id);
    }

    const text = editor.plainText;
    for (const image of images) {
      const token = imageToken(image.ordinal);
      // `indexOf` from the last hit rather than a global regex: the same token can legitimately
      // appear twice, and both occurrences should read as chips.
      let at = text.indexOf(token);
      while (at !== -1) {
        editor.extmarks.create({
          start: at,
          end: at + token.length,
          styleId: chip.styleId,
          typeId: chip.typeId,
          virtual: true,
        });
        at = text.indexOf(token, at + token.length);
      }
    }
  } catch {
    // An unstyled token is a cosmetic loss. Losing the composer is not.
  }
}
