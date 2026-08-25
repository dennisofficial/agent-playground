import React from "react";
import { seamLabel } from "../../../domain/seam.js";
import type { ESessionEndReason } from "../../../generated/prisma/enums.js";
import { useClickRegion } from "../../hooks/use-click-region.js";
import { glyph, theme } from "../../theme.js";

/**
 * A turn that ended badly, and — when it is the one you can still act on — the way to send it again.
 *
 * Retry is a BUTTON, not a key. It read `r to retry` for months and never once worked: the composer
 * takes first refusal on every printable character, so `r` typed an `r` into the draft and the hint
 * was advertising a binding no page could ever claim. That is the same wall `x` for tool expansion
 * hit — see the note at the bottom of `useConversationKeys` — and the answer is the same one, the
 * pointer.
 *
 * `onRetry` absent means this block is not the one offering it: a retryable error further up the
 * scrollback has been superseded, and re-sending is decided by `domain/retry.ts`, not by the colour
 * of a line. Then no affordance is drawn at all, rather than a dead one that lies about what it does.
 */
export function ErrorBlock(props: {
  title: string;
  detail?: string;
  onRetry?: () => void;
}): React.ReactNode {
  const retry = useClickRegion(props.onRetry);
  const label = ` ${glyph.retry} retry `;
  return (
    <box flexDirection="column" marginBottom={1}>
      <text fg={theme.error}>
        {glyph.block} {props.title}
      </text>
      {props.detail ? (
        <text>
          {"  "}
          <span fg={theme.dim}>{glyph.result}</span>
          {"  "}
          <span fg={theme.dim}>{props.detail}</span>
        </text>
      ) : null}
      {props.onRetry ? (
        // A row of two renderables, for the reason `CopyButton` splits its pad off its label: with
        // the gutter inside the clickable text, hovering lights the `⎿` too and the button appears
        // to start three columns left of where a click is actually taken.
        <box flexDirection="row">
          <text fg={theme.dim}>{`  ${glyph.result} `}</text>
          <text {...retry.handlers}>
            <span fg={retry.hovered ? theme.hover : theme.dim} {...retry.wash}>
              {label}
            </span>
          </text>
        </box>
      ) : null}
    </box>
  );
}

/**
 * The session-rotation divider. Derived from `sessionId` changing — nothing is stitched.
 *
 * It names why the PREVIOUS leg ended, because that is the question a break in the page raises and
 * the answers are not interchangeable: an agent that handed over deliberately and one that ran out
 * of room before it could are different things to be scrolling past.
 */
export function SessionSeam(props: {
  ordinal: number;
  endReason: ESessionEndReason | null;
  width: number;
}): React.ReactNode {
  const label = ` ${seamLabel(props)} `;
  const dashes = Math.max(4, Math.floor((props.width - label.length) / 2));
  const rule = "─".repeat(dashes);
  return (
    <box flexDirection="row" marginBottom={1}>
      <text fg={theme.dim}>
        {rule}
        {label}
        {rule}
      </text>
    </box>
  );
}

/**
 * Account rotation: a dim inline note, NOT a divider. Rotation is bookkeeping the user should be
 * able to see but never have to think about — a seam would imply a discontinuity that isn't there,
 * because the session, transcript and scroll are all unchanged.
 */
export function SwapNotice(props: { text: string }): React.ReactNode {
  return (
    <box flexDirection="row" marginBottom={1}>
      <text fg={theme.dim}>
        {"  "}
        {glyph.swap} {props.text}
      </text>
    </box>
  );
}
