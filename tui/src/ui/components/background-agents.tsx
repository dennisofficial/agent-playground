import React from "react";
import { delegateBadge } from "../../domain/delegate-view.js";
import { backgroundDelegates, type Delegates } from "../../domain/delegates.js";
import { clip } from "../../domain/tool-text.js";
import { spinnerFrame, theme } from "../theme.js";

/**
 * Rows before it stops listing and starts counting. Three, because this sits BELOW the composer and
 * every row it takes is a row the transcript does not get — and because a fan-out wide enough to need
 * a fourth is one you read in the transcript, where the block that spawned each one is.
 */
export const BACKGROUND_ROWS = 3;

/**
 * What is still running that you are not looking at.
 *
 * Background delegates are the one kind of work in Atlas with no place in the reading order: the block
 * that launched one has already scrolled past, its result will arrive minutes later somewhere else
 * entirely, and between those two moments the transcript says nothing at all about it. That gap is
 * what this fills — it is the ONLY surface that answers "is something still going" without scrolling.
 *
 * So it lives under the composer rather than above it, with the meters: above the composer is the
 * conversation, and this is not part of the conversation. It draws nothing when nothing is
 * backgrounded, which is almost always, and costs the transcript no rows for the privilege.
 */
export function BackgroundAgents(props: {
  delegates: Delegates;
  width: number;
  /** The page's clock — drives both the elapsed counters and the spinner. */
  now: number;
  maxRows?: number;
}): React.ReactNode {
  const running = backgroundDelegates(props.delegates);
  if (running.length === 0) return null;

  const maxRows = props.maxRows ?? BACKGROUND_ROWS;
  const shown = running.slice(0, maxRows);
  const hidden = running.length - shown.length;
  // The gutter is the spinner, its space, and the `⤷ ` each row leads with.
  const textWidth = Math.max(8, props.width - 4);

  return (
    <box flexDirection="column" width={props.width}>
      <text fg={theme.dim}>
        <span fg={theme.accent}>{spinnerFrame(props.now)}</span>{" "}
        {running.length === 1
          ? "1 agent working in the background"
          : `${running.length} agents working in the background`}
      </text>
      {shown.map((delegate) => (
        <text key={delegate.taskId} fg={theme.dim} wrapMode="none">
          {"  ⤷ "}
          {clip(delegateBadge(delegate, props.now), textWidth)}
        </text>
      ))}
      {hidden > 0 ? <text fg={theme.dim}>{`  · ${hidden} more`}</text> : null}
    </box>
  );
}
