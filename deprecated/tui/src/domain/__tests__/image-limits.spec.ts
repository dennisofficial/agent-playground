import { describe, expect, it } from 'bun:test';
import {
  EImageDelivery,
  MAX_INLINE_BYTES,
  MAX_LONG_EDGE,
  fitted,
  planDelivery,
  pngSize,
  visualTokens,
} from '../image-limits.js';

/** A PNG header with the given dimensions — signature, length, `IHDR`, width, height. */
function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0, 0, 0, 13], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

describe('reading a PNG header', () => {
  it('takes the dimensions out of the IHDR chunk', () => {
    expect(pngSize(pngHeader(2560, 1440))).toEqual({ width: 2560, height: 1440 });
  });

  // The same check tells the clipboard reader that what it got is really a PNG.
  it('refuses anything that is not one', () => {
    expect(pngSize(new Uint8Array(24))).toBeNull();
    expect(pngSize(new Uint8Array([0x89, 0x50]))).toBeNull();

    const wrongChunk = pngHeader(10, 10);
    wrongChunk.set([0x49, 0x44, 0x41, 0x54], 12); // "IDAT" where IHDR must be
    expect(pngSize(wrongChunk)).toBeNull();
  });
});

/**
 * The formula is the API's: 28×28 patches, `⌈w/28⌉ × ⌈h/28⌉`. Worth pinning, because it is the
 * number that decides whether a pasted screenshot is cheap, and it is nothing like intuition.
 */
describe('what an image costs', () => {
  it('counts 28-pixel patches', () => {
    expect(visualTokens({ byteLength: 0, width: 200, height: 200 })).toBe(64);
    expect(visualTokens({ byteLength: 0, width: 1000, height: 1000 })).toBe(1296);
  });

  it('counts a retina screenshot at the tier cap, not at a few hundred', () => {
    expect(visualTokens({ byteLength: 0, width: 2560, height: 1440 })).toBe(4784);
  });

  it('counts an oversized image at what it costs AFTER the API shrinks it', () => {
    // 3840×2160 is downscaled to 2576×1449 before the model ever sees it.
    expect(visualTokens({ byteLength: 0, width: 3840, height: 2160 })).toBe(4784);
  });

  it('has nothing to say about bytes it could not measure', () => {
    expect(visualTokens({ byteLength: 900 })).toBeNull();
  });
});

describe('fitting to the tier', () => {
  it('leaves an image that already fits alone', () => {
    expect(fitted(1920, 1080)).toEqual({ width: 1920, height: 1080 });
  });

  it('scales the long edge down and keeps the aspect ratio', () => {
    expect(fitted(3840, 2160)).toEqual({ width: MAX_LONG_EDGE, height: 1449 });
    // Portrait: the long edge is the height, and it is the one that gets clamped.
    expect(fitted(2160, 3840)).toEqual({ width: 1449, height: MAX_LONG_EDGE });
  });
});

describe('deciding how a picture travels', () => {
  it('inlines an ordinary screenshot as it is', () => {
    const plan = planDelivery({ byteLength: 800_000, width: 1440, height: 900 });
    expect(plan).toEqual({ delivery: EImageDelivery.inline });
  });

  /**
   * The move that makes the byte ceiling almost unreachable: the API downscales past 2576px
   * anyway, so shrinking first costs no fidelity the model would have used and usually takes a
   * heavy image back under the limit.
   */
  it('resizes an oversized one rather than refusing it', () => {
    const plan = planDelivery({ byteLength: 9_000_000, width: 5120, height: 2880 });
    expect(plan.delivery).toBe(EImageDelivery.inline);
    expect(plan.resizeTo).toBe(MAX_LONG_EDGE);
  });

  it('falls back to the path when it is small enough to keep but too heavy to send', () => {
    const plan = planDelivery({
      byteLength: MAX_INLINE_BYTES + 1,
      width: 2000,
      height: 2000,
    });
    expect(plan.delivery).toBe(EImageDelivery.pathOnly);
    // The user is told which limit they hit, in the units they think in.
    expect(plan.reason).toContain('MB');
  });

  // Dimensions unknown — judge on bytes alone rather than guessing.
  it('still inlines unmeasurable bytes that are comfortably small', () => {
    expect(planDelivery({ byteLength: 40_000 }).delivery).toBe(EImageDelivery.inline);
    expect(planDelivery({ byteLength: MAX_INLINE_BYTES + 1 }).delivery).toBe(
      EImageDelivery.pathOnly,
    );
  });
});
