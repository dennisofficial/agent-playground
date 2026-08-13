import React from "react";
import { stripCanary } from "../../../domain/canary.js";
import { THINKING_TAIL_LINES, tail, thinkingSummary, wrapWords } from "../../../domain/truncate.js";
import { useClickRegion } from "../../hooks/use-click-region.js";
import { MarkdownView } from "../../markdown/markdown-view.js";
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
 * at the right margin is a paragraph nobody can read — so the opened block renders as markdown, and
 * only the live tail still hand-wraps its own rows. See the branch below for why they differ.
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

  // Finished and open, so it renders as a DOCUMENT — markdown, like every other prose block.
  // Reasoning is written in markdown by the thing producing it (headings, lists, backticked
  // identifiers), and the collapsed summary already carries "this is quiet", so there is nothing
  // left for verbatim to protect. `dim` is handed to the renderer as the inherited foreground —
  // `proseSyntaxStyle` leaves `default` unstyled precisely so a host can do that — which keeps the
  // body as unlit as it was, while a heading or a bullet still reads as one.
  //
  // Only the FINISHED block. The live tail below keeps its hand-wrapped rows on purpose: it is cut
  // at the top to keep the working line on screen, and a document sliced mid-fence is not one.
  if (!props.streaming) {
    return (
      <box flexDirection="column" marginBottom={1} {...handlers}>
        <text wrapMode="none" width={inner} flexShrink={0}>
          <span fg={theme.dim} {...wash}>
            {glyph.thinking} Thinking…
          </span>
          <span {...wash}>{fill(11)}</span>
        </text>
        <text> </text>
        {/* The wash lands twice: on the box, so the indent and the short end of every line are
            lit, and on the markdown itself, so its own cells paint the hover rather than punch
            holes in it. Hover is the affordance that says what a click collapses — losing it on
            the body would leave the header claiming a region it no longer shows. */}
        <box
          flexDirection="column"
          width={inner}
          flexShrink={0}
          paddingLeft={2}
          {...(wash.bg === undefined ? {} : { backgroundColor: wash.bg })}
        >
          <MarkdownView source={text} width={band} fg={theme.dim} {...wash} />
        </box>
      </box>
    );
  }

  const rows = text.split("\n").flatMap((line) => wrapWords(line, band));
  // The live block tails. Reasoning runs for pages, and a block that grows a row per token walks the
  // working line — the thing that says work is still happening — off the bottom of the screen.
  // Nothing is lost by cutting the top: the moment the stream ends this becomes a message, collapses
  // to its one-line summary, and clicking it shows every row, laid out.
  const view = tail(rows, THINKING_TAIL_LINES);

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
          {rowIndex === view.shown.length - 1 ? (
            <span>{glyph.caret}</span>
          ) : null}
        </text>
      ))}
    </box>
  );
}
