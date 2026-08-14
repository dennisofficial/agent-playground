/**
 * How a pasted image reaches the model: inline, resized-then-inline, or by path alone.
 *
 * Every number here is an API limit, not a preference:
 *
 * - **10 MB base64 per image**, and base64 inflates by a third, so the real ceiling on the bytes is
 *   about 7.5 MB. `MAX_INLINE_BYTES` sits well under it — a rejected turn costs the user the words
 *   they wrote, and no picture is worth that.
 * - **2576 px on the long edge** is the high-resolution tier's maximum, and the API downscales past
 *   it regardless. Sending a 5K screenshot whole spends the bytes and buys nothing: the model sees
 *   the same 2576 px either way. Resizing first is not a quality decision, it is a free one.
 * - **4784 visual tokens** is the cap that falls out of that edge, since an image costs
 *   `⌈width / 28⌉ × ⌈height / 28⌉` — the model reads 28×28 patches, not pixels.
 *
 * The last one is worth knowing before deciding an image is cheap: a retina screenshot is not a
 * few hundred tokens, it is the cap.
 */

/** The high-resolution tier's long edge. Anything larger is downscaled by the API anyway. */
export const MAX_LONG_EDGE = 2576;

/**
 * The most raw bytes worth inlining.
 *
 * Five megabytes rather than the API's seven-and-a-half: the limit is on the BASE64, the encoding
 * adds a third, and the margin covers the prose and the rest of the turn travelling with it.
 */
export const MAX_INLINE_BYTES = 5 * 1024 * 1024;

export enum EImageDelivery {
  /** Base64 content block. The model sees the picture whether or not it thinks to look. */
  inline = "inline",
  /** Too big to inline. The path goes in the manifest and the agent can Read it if it wants. */
  pathOnly = "path-only",
}

export type ImageFacts = {
  byteLength: number;
  /** Absent when the bytes are not a PNG we could measure. */
  width?: number | undefined;
  height?: number | undefined;
};

export type DeliveryPlan = {
  delivery: EImageDelivery;
  /** Downscale to this long edge first. Absent when the image is already small enough. */
  resizeTo?: number;
  /** Why it is not being inlined — shown to the user, who is owed an explanation. */
  reason?: string;
};

export function planDelivery(facts: ImageFacts): DeliveryPlan {
  const longEdge = Math.max(facts.width ?? 0, facts.height ?? 0);
  const oversized = longEdge > MAX_LONG_EDGE;

  // Resizing is the first move, not the last resort: it is what the API would do anyway, and it
  // takes most images that are too heavy to inline back under the ceiling.
  if (oversized) return { delivery: EImageDelivery.inline, resizeTo: MAX_LONG_EDGE };

  if (facts.byteLength > MAX_INLINE_BYTES) {
    return {
      delivery: EImageDelivery.pathOnly,
      reason: `${megabytes(facts.byteLength)} is past the ${megabytes(MAX_INLINE_BYTES)} inline limit`,
    };
  }

  return { delivery: EImageDelivery.inline };
}

/**
 * What the image costs the turn, in visual tokens.
 *
 * Reported rather than enforced. It is the number that decides whether pasting four screenshots
 * into one conversation is free or expensive, and nothing else in Atlas can answer it.
 */
export function visualTokens(facts: ImageFacts): number | null {
  if (facts.width === undefined || facts.height === undefined) return null;
  const { width, height } = fitted(facts.width, facts.height);
  return Math.ceil(width / 28) * Math.ceil(height / 28);
}

/** The size the API will actually read the image at, aspect ratio preserved. */
export function fitted(
  width: number,
  height: number,
): { width: number; height: number } {
  const longEdge = Math.max(width, height);
  if (longEdge <= MAX_LONG_EDGE) return { width, height };
  const scale = MAX_LONG_EDGE / longEdge;
  return {
    width: Math.round(width * scale),
    height: Math.round(height * scale),
  };
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * A PNG's dimensions, straight out of its IHDR chunk.
 *
 * Sixteen bytes in, two big-endian 32-bit integers, and the chunk is mandatory and always first —
 * so this is exact, instant, and needs no image library and no subprocess. Returns null for
 * anything that is not a PNG, which is also the signature check the clipboard reader wants.
 */
export function pngSize(
  bytes: Uint8Array,
): { width: number; height: number } | null {
  if (bytes.byteLength < 24) return null;
  if (!PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) return null;
  // Bytes 12–15 are the chunk type. A PNG whose first chunk is not IHDR is malformed.
  if (String.fromCharCode(...bytes.slice(12, 16)) !== "IHDR") return null;

  return { width: readUint32(bytes, 16), height: readUint32(bytes, 20) };
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] as number) << 24) |
    ((bytes[offset + 1] as number) << 16) |
    ((bytes[offset + 2] as number) << 8) |
    (bytes[offset + 3] as number)
  );
}

function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
