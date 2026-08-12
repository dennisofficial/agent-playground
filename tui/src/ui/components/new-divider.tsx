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
