import { useTerminalDimensions } from "@opentui/react";
import React from "react";
import type { DraftImage } from "../../../domain/draft-images.js";
import { EImageDelivery } from "../../../domain/image-limits.js";
import { MarkdownView } from "../../markdown/markdown-view.js";
import { glyph, theme, TRANSCRIPT_INSET } from "../../theme.js";

/** The `❯ ` marker column. Held for the whole block, so the prose has one left edge. */
const GUTTER = 2;
/** A column of air at the right margin, so a wrapped line never runs flush into the track. */
const PAD = 1;
const RESERVED = GUTTER + PAD + TRANSCRIPT_INSET;

/**
 * The user's own turns, rendered as MARKDOWN — the same renderer the agent's prose and Atlas's
 * hand-offs go through.
 *
 * Verbatim was the earlier call, and for the same reason it was the earlier call on `HarnessBlock`:
 * these are the bytes the model was handed, and restyling them puts the transcript a step away from
 * what happened. It loses on the same argument too. People write to agents in markdown — backticked
 * paths, a numbered list of requirements, a pasted fence — so verbatim meant the author paying in
 * `` ` `` and `-` to read back their own prose, while the agent's reply two blocks down got laid
 * out. Nothing is lost: styling happens at render, and the row still holds what was sent.
 *
 * The one thing that changes for the reader is a pasted fence, which now draws as a fenced block
 * with its own copy button instead of as indented lines — which is the point.
 */
export function UserBlock(props: {
  text: string;
  images?: readonly DraftImage[];
  width?: number;
}): React.ReactNode {
  const { width } = useTerminalDimensions();
  // Markdown needs a hard column: it wraps prose itself, and a fence decides whether it overflows
  // before it draws. What the slab gives the body is the transcript's width less its own chrome.
  const columns = Math.max(20, (props.width ?? width) - RESERVED);

  return (
    <box
      flexDirection="row"
      marginBottom={1}
      backgroundColor={theme.userBg}
      flexShrink={0}
    >
      {/* Sits on the slab the parent painted, on the first row only — a marker, not a rule. */}
      <text fg={theme.userFg} bg={theme.userBg} flexShrink={0}>
        {glyph.user}{" "}
      </text>
      <box
        flexDirection="column"
        flexGrow={1}
        flexShrink={1}
        flexBasis={0}
        paddingRight={PAD}
      >
        {/* Both colours reach `<markdown>` explicitly: `proseSyntaxStyle` leaves `default`
            unstyled so prose inherits its foreground, and a wrapped line has to paint the slab
            under itself rather than leave a hole in it. See `HarnessBlock`. */}
        <MarkdownView
          source={props.text}
          width={columns}
          fg={theme.userFg}
          bg={theme.userBg}
        />

        {/*
          A line per picture, under the words that referred to it.

          The terminal cannot draw the image, and the `[Image #1]` token in the prose above is not
          evidence that anything was actually sent — someone can type those characters. This is: it
          says a real file went with the message, how big it was, and what it cost.
        */}
        {(props.images ?? []).map((image) => (
          <text key={image.ordinal} fg={theme.dim}>
            {`${glyph.image} attached ${image.ordinal} · ${describe(image)}`}
          </text>
        ))}
      </box>
    </box>
  );
}

/**
 * `1440×900 · 47 KB · 1560 tokens`, or `· by path` when it was too heavy to inline.
 *
 * The token count earns its place: an image is the one thing in a transcript whose cost is
 * invisible and nothing like intuition — a retina screenshot is not a few hundred tokens, it is
 * nearly five thousand — and this is the only place a person can see what a paste actually spent.
 */
function describe(image: DraftImage): string {
  const parts: string[] = [];
  if (image.width !== undefined && image.height !== undefined) {
    parts.push(`${image.width}×${image.height}`);
  }
  parts.push(`${Math.max(1, Math.round(image.byteLength / 1024))} KB`);
  if (image.delivery === EImageDelivery.pathOnly) {
    parts.push("by path");
  } else if (image.tokens !== undefined) {
    parts.push(`${image.tokens} tokens`);
  }
  return parts.join(" · ");
}
