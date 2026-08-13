import React from "react";
import { theme, TRANSCRIPT_INSET } from "../theme.js";

/**
 * The id the transcript hangs on the oldest message you have not seen, so the scrollbox can be told
 * to land there. A constant rather than the message's own id because `scrollChildIntoView` takes one
 * string and the page should not have to thread a second one through to reach it.
 */
export const UNSEEN_ANCHOR_ID = "atlas-unseen-anchor";

/**
 * `─── new ───`, above the oldest message you have not seen.
 *
 * It spans the FULL transcript width rather than a capped reading column: unlike the session seam,
 * this rule is a boundary in time you are meant to find by scanning, and a short rule floating in a
 * wide column reads as decoration rather than an edge.
 *
 * It is drawn for the whole VISIT, not until you scroll past it: a boundary that moves while you
 * are reading is worse than none, because the thing it was marking is then unfindable. It is not
 * drawn at all when everything is new — a rule at the very top of a transcript separates nothing
 * from something.
 */
export function NewDivider(props: { width: number }): React.ReactNode {
  const label = " new ";
  // `props.width` is the TERMINAL's width; the rule has to fit the column the transcript actually
  // hands a block, or it wraps and the seam becomes two lines. See `TRANSCRIPT_INSET`.
  //
  // Split the remaining columns in two, and give the odd one to the right so the label sits on the
  // same cell as it would in a centred layout. `max(4, …)` keeps the rule legible when the terminal
  // is narrower than the label plus its stubs.
  const total = Math.max(label.length + 8, props.width - TRANSCRIPT_INSET);
  const left = Math.max(4, Math.floor((total - label.length) / 2));
  const right = Math.max(4, total - label.length - left);
  return (
    <box flexDirection="row" marginTop={1} marginBottom={1}>
      {/* The one place in the transcript that takes the "yours" court colour: it is the only mark
          that exists because of something YOU have not done. */}
      <text fg={theme.court.yours}>
        {"─".repeat(left)}
        {label}
        {"─".repeat(right)}
      </text>
    </box>
  );
}

const JUMP_LABEL = "⌄ jump to bottom · ctrl+b";

/** The pill's own width: the label and one column of breathing room each side. */
const JUMP_WIDTH = JUMP_LABEL.length + 2;

/**
 * `⌄ jump to bottom` — shown only while the transcript is scrolled away from the end.
 *
 * Landing mid-history without an escape hatch is worse than landing at the end, and the escape has
 * to be visible: the keyboard belongs to the draft here, so a key alone would be a secret.
 *
 * It FLOATS at the bottom of the transcript's viewport rather than taking a row above the composer.
 * A row in the footer is a row the transcript never gets back, and the thing it points at — the
 * bottom of the scroll — was two panels away from the words offering to take you there. As an
 * overlay it costs nothing when it is absent, and when it is present it sits exactly where the
 * gesture lands. Absolute rather than last-child so it does not push the working line up a row the
 * moment you scroll, which read as the transcript twitching.
 *
 * It is opaque, because it is drawn OVER live text: a bare label sharing cells with a half-covered
 * sentence is unreadable. One row and no border — a bordered box is three rows, which is a third of
 * a short terminal's transcript blanked to say one sentence. What says "chrome, not a message" is
 * the fill and the lit text on it, which is enough at this size. Centred, so it lands where the eye
 * already is rather than in a corner it has to be found in.
 *
 * `width` is the TERMINAL's; the pill is centred over the column the transcript actually draws in,
 * which is that much narrower — see `TRANSCRIPT_INSET`.
 */
export function JumpToBottom(props: {
  width: number;
  onJump: () => void;
}): React.ReactNode {
  const left = Math.max(
    0,
    Math.floor((props.width - TRANSCRIPT_INSET - JUMP_WIDTH) / 2),
  );
  return (
    <box
      position="absolute"
      bottom={0}
      left={left}
      // Above the transcript it covers. The scrollbox and its blocks all sit at the default 0.
      zIndex={10}
      flexDirection="row"
      paddingLeft={1}
      paddingRight={1}
      // Named rather than inherited: an overlay with a transparent interior shows the text it is
      // supposed to be covering straight through its own middle.
      backgroundColor={theme.overlayBg}
      onMouseDown={props.onJump}
    >
      {/* Lit rather than dim, unlike every other hint: dim text on the overlay's own dark fill is
          two quiet things stacked, and this one is the way out of a place you did not mean to be. */}
      <text fg={theme.hover} bg={theme.overlayBg}>
        {JUMP_LABEL}
      </text>
    </box>
  );
}
