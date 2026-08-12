import React from "react";
import { seamLabel } from "../../../domain/seam.js";
import type { ESessionEndReason } from "../../../generated/prisma/enums.js";
import { glyph, theme } from "../../theme.js";

export function ErrorBlock(props: {
  title: string;
  detail?: string;
  retryable?: boolean;
}): React.ReactNode {
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
      {props.retryable ? (
        <text>
          {"  "}
          <span fg={theme.dim}>{glyph.result}</span>
          {"  "}
          <span fg={theme.dim}>r to retry</span>
        </text>
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
