import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CliRenderer } from "@opentui/core";
import {
  EImageDelivery,
  planDelivery,
  pngSize,
  visualTokens,
} from "../domain/image-limits.js";

/**
 * An image off the system clipboard.
 *
 * It cannot arrive through the paste channel: bracketed paste is TEXT, and while OpenTUI's
 * `PasteMetadata` declares a `mimeType` and a `binary` kind, nothing populates them — the stdin
 * parser builds every paste event out of bracketed-paste bytes. `pbpaste` returns the empty string
 * when the clipboard holds a picture, which is why ⌘V used to do nothing at all here, silently.
 *
 * So it is PULLED, on ctrl+v, and ctrl+v rather than ⌘V because the terminal keeps ⌘V for itself
 * and hands us the empty text paste it made of it.
 */
export type ClipboardImage = {
  path: string;
  mediaType: string;
  byteLength: number;
  width?: number | undefined;
  height?: number | undefined;
  /** Inline as a content block, or hand the agent the path — see `domain/image-limits.ts`. */
  delivery: EImageDelivery;
  /** What it will cost the turn, when we could measure it. */
  tokens?: number | undefined;
  /** Why it is not being inlined, when it is not. */
  reason?: string | undefined;
};

/** `«data PNGf8950…»` — AppleScript's hex rendering of raw clipboard data. */
const PNG_HEX = /«data PNGf([0-9A-Fa-f]+)»/;

/**
 * Reads the clipboard as a PNG and writes it to `path`, or returns null when it holds anything else.
 *
 * The non-zero exit IS the "is there an image?" test — osascript refuses the coercion for text, for
 * an empty clipboard, and for a file promise alike, and none of those is an error worth reporting.
 */
export function readClipboardImage(path: string): ClipboardImage | null {
  if (process.platform !== "darwin") return null;

  const result = Bun.spawnSync([
    "osascript",
    "-e",
    "the clipboard as «class PNGf»",
  ]);
  if (result.exitCode !== 0) return null;

  const match = PNG_HEX.exec(result.stdout.toString());
  if (!match) return null;

  const bytes = Buffer.from(match[1] as string, "hex");
  // `pngSize` doubles as the signature check. A PNG that did not survive the round trip is worse
  // than no image: it would reach the model as corrupt base64 and fail the turn rather than the
  // paste.
  const size = pngSize(bytes);
  if (!size) return null;

  mkdirSync(dirname(path), { recursive: true });
  Bun.write(path, bytes);

  const plan = planDelivery({ byteLength: bytes.byteLength, ...size });
  // Shrink to the tier's long edge when it is over. Not a quality decision — the API downscales
  // past 2576px regardless, so the extra pixels were never going to be read.
  const shrunk = plan.resizeTo === undefined ? null : shrink(path, plan.resizeTo);
  const final = shrunk ?? { byteLength: bytes.byteLength, ...size };

  // Re-planned against what is actually on disk now: a resize usually takes an image that was too
  // heavy back under the inline ceiling, and the first plan was made before it happened.
  const settled = planDelivery(final);

  return {
    path,
    mediaType: "image/png",
    byteLength: final.byteLength,
    width: final.width,
    height: final.height,
    delivery: settled.delivery,
    tokens: visualTokens(final) ?? undefined,
    reason: settled.reason,
  };
}

/**
 * Downscale in place with `sips`, which ships with macOS — the same reason the clipboard read is an
 * `osascript` call. A failure here is not fatal: the original file is still on disk and still
 * sendable, so this returns null and the caller keeps what it had.
 */
function shrink(
  path: string,
  longEdge: number,
): { byteLength: number; width: number; height: number } | null {
  const result = Bun.spawnSync(["sips", "-Z", String(longEdge), path]);
  if (result.exitCode !== 0) return null;

  const bytes = readFileSync(path);
  const size = pngSize(bytes);
  if (!size) return null;
  return { byteLength: bytes.byteLength, ...size };
}

export function copyToClipboard(renderer: CliRenderer, text: string): boolean {
  if (renderer.isOsc52Supported() && renderer.copyToClipboardOSC52(text))
    return true;
  if (process.platform !== "darwin") return false;

  try {
    // Synchronous: a copy that reports success before the write lands would show "copied" over a
    // clipboard that still holds the old text.
    const result = Bun.spawnSync(["pbcopy"], { stdin: Buffer.from(text) });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}
