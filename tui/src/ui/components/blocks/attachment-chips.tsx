import React from "react";
import {
  attachmentChip,
  type AttachmentPart,
} from "../../../domain/attachments.js";
import { fitDiffText } from "../../../domain/diff-layout.js";
import { useClickRegion } from "../../hooks/use-click-region.js";
import { glyph, theme } from "../../theme.js";

/** What a chip sizes itself to when it is drawn outside a measured transcript (tests). */
const DEFAULT_WIDTH = 80;

/** Where an expanded body hangs: under the chip's text, past `▶ ⎿ `. */
const BODY_INDENT = "    ";

/**
 * The files a seam handed over, as chips under the prose that explains them.
 *
 * Collapsed by default, because an inlined spec runs to pages and the reader is looking at the
 * hand-off, not at the spec. The `⎿` is the transcript's existing idiom for "this came with the
 * thing above it" — a tool's result uses it and an attachment is the same relationship — so a chip
 * needs no legend to be read as belonging to the message above it, and the `▶` says it opens.
 *
 * Drawn INSIDE the harness slab, without a rule of their own: these ARE part of Atlas's message, and
 * the slab's left edge already runs past them, so a per-line `┃` here would only repeat it.
 *
 * What expands is the STORED body, never a fresh read. `specs/` is mutable during build, so the file
 * on disk today can differ from what this thread was given, and a transcript's job is to say what
 * happened rather than what is currently true.
 */
export function AttachmentChips(props: {
  parts: readonly AttachmentPart[];
  expanded?: boolean;
  /** The reading width, so a long line in an attached file cannot escape the column. */
  width?: number;
  /**
   * Opens and closes the whole manifest.
   *
   * Per MESSAGE rather than per chip: a hand-off's files are one thing you either wanted to read or did
   * not, and four clicks to open four attachments of one message is not a feature. It also had to become
   * a click at all — `x` / `X` were the only way in, and they could never fire, because the composer
   * takes first refusal on every key and consumes printable characters.
   */
  onToggle?: () => void;
}): React.ReactNode {
  const { handlers, wash } = useClickRegion(props.onToggle);
  if (props.parts.length === 0) return null;
  const columns = Math.max(
    20,
    (props.width ?? DEFAULT_WIDTH) - BODY_INDENT.length,
  );

  return (
    <box flexDirection="column" {...handlers}>
      {props.parts.map((part, index) => (
        <box key={index} flexDirection="column">
          <text wrapMode="none">
            <span fg={theme.dim} {...wash}>
              {props.expanded ? "▼" : "▶"}{" "}
            </span>
            <span fg={theme.dim} {...wash}>
              {glyph.result}{" "}
            </span>
            {/* A missing file keeps its chip in red rather than vanishing: what the seam TRIED to
                hand over is exactly the thing a silent drop would have cost the reader. */}
            <span fg={part.body === null ? theme.error : undefined} {...wash}>
              {attachmentChip(part)}
            </span>
          </text>
          {props.expanded && part.body !== null
            ? part.body.split("\n").map((line, row) => (
                // `wrapMode="none"` plus a hard clip, for the reason the diff rows carry it: an
                // attached file is arbitrary text, and one 400-column line of it would otherwise
                // wrap into a paragraph and take the whole transcript with it.
                <text key={row} fg={theme.dim} wrapMode="none">
                  {BODY_INDENT}
                  {fitDiffText({ text: line, columns, padded: false })}
                </text>
              ))
            : null}
        </box>
      ))}
    </box>
  );
}
