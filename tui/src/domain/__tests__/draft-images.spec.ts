import { describe, expect, it } from 'bun:test';
import {
  imageToken,
  imagesInDraft,
  nextOrdinal,
  type DraftImage,
} from '../draft-images.js';

function image(ordinal: number): DraftImage {
  return {
    ordinal,
    path: `/tmp/atlas-paste-${ordinal}.png`,
    mediaType: 'image/png',
    byteLength: 100 + ordinal,
  };
}

describe('numbering', () => {
  it('starts at one', () => {
    expect(nextOrdinal([])).toBe(1);
    expect(imageToken(1)).toBe('[Image #1]');
  });

  // The bargain the whole module rests on: a token is an identity, not a position.
  it('never reissues a number, even after the one before it was deleted', () => {
    const images = [image(1), image(2)];
    expect(nextOrdinal(images)).toBe(3);
    // #1's token has been rubbed out of the draft, but its number is spent.
    expect(nextOrdinal([image(2)])).toBe(3);
  });
});

describe('what the draft still refers to', () => {
  const images = [image(1), image(2), image(3)];

  it('sends the images whose tokens survived, in the order they are written', () => {
    const found = imagesInDraft('look at [Image #3] and then [Image #1]', images);
    expect(found.map((found) => found.ordinal)).toEqual([3, 1]);
  });

  it('drops an image whose token was deleted', () => {
    expect(imagesInDraft('only [Image #2] left', images).map((f) => f.ordinal)).toEqual([2]);
    expect(imagesInDraft('no tokens at all', images)).toEqual([]);
  });

  it('sends an image once however many times it is mentioned', () => {
    const found = imagesInDraft('[Image #1] versus [Image #1]', images);
    expect(found.map((f) => f.ordinal)).toEqual([1]);
  });

  // Someone writing about the feature, rather than using it.
  it('treats a token with no image behind it as ordinary words', () => {
    expect(imagesInDraft('type [Image #9] to see what happens', images)).toEqual([]);
  });
});
