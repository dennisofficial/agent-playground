import { EImageDelivery } from './image-limits.js';

/**
 * Images pasted into a draft.
 *
 * Deliberately NOT "attachments": `domain/attachments.ts` already owns that word for the context
 * files a phase hand-off carries from one thread to the next, and the two have nothing to do with
 * each other. These are pictures a person put in a message.
 *
 * The draft holds a TOKEN — `[Image #1]` — and the bytes sit beside it on disk. That is what makes
 * the draft a string the whole way through: it survives `store.draft`, it survives leaving the page,
 * and the composer's buffer never has to know that some of its characters are special.
 */

export type DraftImage = {
  /** The number in this image's token. Stable for the life of the draft. */
  readonly ordinal: number;
  /** Where the bytes were written when the clipboard was read — under `context/uploads/`. */
  readonly path: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  /**
   * Inline as a content block, or by path alone.
   *
   * Inline is the default and the point: the model sees the picture whether or not it thinks to
   * look. `path-only` is the fallback for something too heavy to send, and the manifest still
   * names it — see `domain/image-limits.ts`.
   */
  readonly delivery: EImageDelivery;
  /** Visual tokens it will cost the turn, when the dimensions were readable. */
  readonly tokens?: number | undefined;
};

const TOKEN = /\[Image #(\d+)\]/g;

export function imageToken(ordinal: number): string {
  return `[Image #${ordinal}]`;
}

/**
 * The next free number.
 *
 * `max + 1` rather than `length + 1`, because deleting the token for #1 and pasting again must not
 * mint a second #2 — two images answering to one token is a picture going to the model twice while
 * another never arrives.
 */
export function nextOrdinal(images: readonly DraftImage[]): number {
  return images.reduce((highest, image) => Math.max(highest, image.ordinal), 0) + 1;
}

/**
 * The images this draft still refers to, in the order their tokens appear in it.
 *
 * Deleting the token is how you delete the image — there is no second gesture to learn, and no way
 * to send a picture you can no longer see a mention of. Tokens are never renumbered while typing:
 * rewriting the words under someone mid-sentence to keep a counter tidy is a worse bargain than a
 * draft that reads `[Image #1] [Image #3]`.
 */
export function imagesInDraft(
  text: string,
  images: readonly DraftImage[],
): readonly DraftImage[] {
  const byOrdinal = new Map(images.map((image) => [image.ordinal, image]));
  const found: DraftImage[] = [];
  const seen = new Set<number>();

  for (const match of text.matchAll(TOKEN)) {
    const ordinal = Number(match[1]);
    const image = byOrdinal.get(ordinal);
    // A token for an image that is not in the list is just words — someone typed `[Image #9]`
    // themselves, and inventing a picture for it would be worse than letting it through as text.
    if (!image || seen.has(ordinal)) continue;
    seen.add(ordinal);
    found.push(image);
  }

  return found;
}
