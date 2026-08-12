import React from "react";
import { theme } from "../theme.js";

/**
 * The id the transcript hangs on the oldest message you have not seen, so the scrollbox can be told
 * to land there. A constant rather than the message's own id because `scrollChildIntoView` takes one
 * string and the page should not have to thread a second one through to reach it.
 */
export const UNSEEN_ANCHOR_ID = "atlas-unseen-anchor";

/** The seam rule's cap: a rule wider than the reading column stops reading as a rule. */
const MAX = 72;

/**
 * `─── new ───`, above the oldest message you have not seen.
 *
 * It is drawn for the whole VISIT, not until you scroll past it: a boundary that moves while you
 * are reading is worse than none, because the thing it was marking is then unfindable. It is not
 * drawn at all when everything is new — a rule at the very top of a transcript separates nothing
 * from something.
 */
export function NewDivider(props: { width: number }): React.ReactNode {
  const label = " new ";
  const dashes = Math.max(4, Math.floor((Math.min(props.width, MAX) - label.length) / 2));
  const rule = "─".repeat(dashes);
  return (
    <box flexDirection="row" marginTop={1} marginBottom={1}>
      {/* The one place in the transcript that takes the "yours" court colour: it is the only mark
          that exists because of something YOU have not done. */}
      <text fg={theme.court.yours}>
        {rule}
        {label}
        {rule}
      </text>
    </box>
  );
}

/**
 * `⌄ jump to bottom` — shown only while the transcript is scrolled away from the end.
 *
 * Landing mid-history without an escape hatch is worse than landing at the end, and the escape has
 * to be visible: the keyboard belongs to the draft here, so a key alone would be a secret.
 */
export function JumpToBottom(props: { onJump: () => void }): React.ReactNode {
  return (
    <box flexDirection="row" onMouseDown={props.onJump}>
      <text fg={theme.dim}>{"⌄ jump to bottom · ctrl+b"}</text>
    </box>
  );
}
