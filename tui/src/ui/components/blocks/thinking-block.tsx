import React from "react";
import { stripCanary } from "../../../domain/canary.js";
import { THINKING_TAIL_LINES, tail, thinkingSummary, wrapWords } from "../../../domain/truncate.js";
import { useClickRegion } from "../../hooks/use-click-region.js";
import { glyph, theme, TRANSCRIPT_INSET } from "../../theme.js";

const DEFAULT_WIDTH = 80;
/**
 * The agent's reasoning: one dim line, or the whole thing.
 *
 * Expandable by pointer under the same rule as a tool group — click the summary to open it, click
 * ANYWHERE in the open body to close it, and hovering lights every line of the block so what is lit is
 * what a click collapses. Thinking is the case that most needs the second half: it runs for pages, and
 * having to scroll back to the `✻` line to close it is the whole reason the rule exists.
 *
 * Wrapped, not clipped. Thinking is the most prose-shaped thing in the transcript, and a paragraph cut
 * at the right margin is a paragraph nobody can read.
 */
export function ThinkingBlock(props: {
  text: string;
  streaming?: boolean;
  expanded?: boolean;
  /** Absent for the live tail, which is not a message and so has nothing to key an expansion on. */
  onToggle?: () => void;
  width?: number;
}): React.ReactNode {
  // Every prose surface strips, not just the assistant one — an agent that opens its thinking with the
  // glyph should read the same as one that opens its answer with it. See `domain/canary.ts`.
  const text = stripCanary(props.text);

  const width = props.width ?? DEFAULT_WIDTH;
  const inner = Math.max(24, width - TRANSCRIPT_INSET);
  /** Out to the right margin, so a hover wash covers the ROW and not just the words. */
  const fill = (used: number): string => " ".repeat(Math.max(0, inner - used));
  // The live tail is not a message, so it has nothing to key an expansion on and is not clickable.
  const { handlers, wash } = useClickRegion(
    props.streaming ? undefined : props.onToggle,
  );

  if (!props.streaming && !props.expanded) {
    const summary = `${glyph.thinking} ${thinkingSummary(text)}`;
    return (
      <box flexDirection="row" marginBottom={1}>
        <text wrapMode="none" width={inner} flexShrink={0} {...handlers}>
          <span fg={theme.dim} {...wash}>
            {summary}
          </span>
          <span {...wash}>{fill(summary.length)}</span>
        </text>
      </box>
    );
  }

  const band = Math.max(20, inner - 2);
  const rows = text.split("\n").flatMap((line) => wrapWords(line, band));
  // The live block tails; the finished one opens whole. Reasoning runs for pages, and a block that
  // grows a row per token walks the working line — the thing that says work is still happening — off
  // the bottom of the screen. Nothing is lost by cutting the top: the moment the stream ends this
  // becomes a message, collapses to its one-line summary, and clicking it shows every row.
  const view = props.streaming
    ? tail(rows, THINKING_TAIL_LINES)
    : { shown: rows, hidden: 0, notice: null };

  return (
    <box flexDirection="column" marginBottom={1} {...handlers}>
      <text wrapMode="none" width={inner} flexShrink={0}>
        <span fg={theme.dim} {...wash}>
          {glyph.thinking} Thinking…
        </span>
        <span {...wash}>{fill(11)}</span>
      </text>
      <text> </text>
      {view.notice === null ? null : (
        <text wrapMode="none" width={inner} flexShrink={0}>
          <span fg={theme.dim} {...wash}>
            {"  "}
            {view.notice}
          </span>
          <span {...wash}>{fill(2 + view.notice.length)}</span>
        </text>
      )}
      {view.shown.map((row, rowIndex) => (
        <text key={rowIndex} wrapMode="none" width={inner} flexShrink={0}>
          <span fg={theme.dim} {...wash}>
            {"  "}
            {row}
          </span>
          <span {...wash}>{fill(2 + row.length)}</span>
          {props.streaming && rowIndex === view.shown.length - 1 ? (
            <span>{glyph.caret}</span>
          ) : null}
        </text>
      ))}
    </box>
  );
}
