import { createTextAttributes } from "@opentui/core";
import React from "react";
import { EAttentionCourt } from "../../domain/attention.js";
import {
  EHeaderChip,
  fitHeaderChips,
  headerPlace,
  headerStatusText,
  type HeaderChip,
  type HeaderFacts,
} from "../../domain/conversation-header.js";
import { courtColour } from "../court.js";
import { formatElapsed, glyph, theme } from "../theme.js";

/**
 * The conversation's two lines, and the only thing identifying a tile in a grid of them.
 *
 * Every decision about WHAT appears and what is given up first lives in
 * `domain/conversation-header.ts`, where it is asserted at sixty and a hundred and twenty columns
 * without a terminal. This file is the half that cannot be: colour, weight, and the rule underneath.
 *
 *   ⠹ redesign the conversation header                              working… 1m 12s
 *     atlas  ⑂ atlas/redesign-the-conversation-header-a1b2c3d4   implementer · +2 threads
 *   ────────────────────────────────────────────────────────────────────────────────────
 *
 * Three rows rather than the two the old one-line header spent. The extra row buys the thing the
 * flat version could not have at any width: nothing on it is abbreviated, so no glyph needs a
 * legend and the title never competes with the metadata for the same span of columns.
 */

/** The gutter row 1's glyph occupies, which row 2 indents past so the two left edges agree. */
const GUTTER = 2;

export function ConversationHeader(props: {
  facts: HeaderFacts;
  width: number;
  /** Milliseconds the current turn has been in flight, or null when nothing is running. */
  elapsedMs: number | null;
  /** The spinner's frame. Shared with the transcript's clock, so the two never beat against each other. */
  frame: string;
}): React.ReactNode {
  const { facts, width } = props;
  const place = headerPlace(facts.git);
  const status = headerStatusText({
    facts,
    elapsed: props.elapsedMs === null ? null : formatElapsed(props.elapsedMs),
  });
  const court = courtColour(facts.status.court);

  // Half the line, so a long branch and a long role never meet in the middle. The chips measure
  // against this and the left side clips against what is left.
  const chips = fitHeaderChips({ facts, room: Math.floor(width / 2) });

  return (
    <box flexDirection="column" width={width}>
      <Row
        width={width}
        left={[
          { text: `${lead(facts, props.frame)} `, fg: facts.closed ? theme.court.none : court },
          { text: facts.jobTitle, fg: theme.hover, bold: true },
        ]}
        right={[{ text: status, fg: facts.closed ? theme.warn : court }]}
      />
      <Row
        width={width}
        left={[
          { text: " ".repeat(GUTTER) },
          { text: facts.repo, fg: theme.dim },
          { text: "  " },
          { text: `${place.glyph} `, fg: theme.rule },
          ...(place.path === null ? [] : [{ text: `${place.path} `, fg: theme.dim }]),
          { text: place.branch, fg: theme.meta },
        ]}
        right={chipSpans(chips)}
      />
      {/*
        The rule, not a blank row.

        The old header spent a blank row here purely to keep itself off the transcript; a rule does
        that job better and costs the same, and it is what makes two header rows read as one region
        rather than as two stray lines above a log.
      */}
      <text fg={theme.rule}>{"─".repeat(Math.max(0, width))}</text>
    </box>
  );
}

/**
 * The lead glyph: the spinner while a turn runs, `❯` when the ball is yours, a dim `·` otherwise.
 *
 * Deliberately separate from the status WORD on the right. A closed thread has no court, so folding
 * the two together printed `closed` into the glyph cell and ran it straight into the job title.
 */
function lead(facts: HeaderFacts, frame: string): string {
  if (facts.closed) return glyph.seen;
  if (facts.status.spinner) return frame;
  return facts.status.court === EAttentionCourt.yours ? glyph.user : glyph.seen;
}

/**
 * A chip's colour, read at render.
 *
 * These two tables used to be module-level maps of hexes, which made them a copy of the palette
 * taken at import — and being in a `.tsx` did not save them, because a hook cannot reach module
 * scope. `courtColour` (`ui/court.ts`) is the same lookup for the same enum, so the court case
 * defers to it rather than keeping a second table that could disagree.
 */
function chipColour(kind: EHeaderChip): string {
  // What the agent will do, in the same weight the metadata row is read at.
  if (kind === EHeaderChip.role) return theme.meta;
  // The accent, because it is the one thing on this line that is about work happening RIGHT NOW —
  // and the only fact here you would otherwise never learn.
  return theme.court.agent;
}

function chipSpans(chips: HeaderChip[]): Span[] {
  return chips.flatMap((chip, index) => [
    ...(index === 0 ? [] : [{ text: " · ", fg: theme.rule }]),
    { text: chip.text, fg: chipColour(chip.kind) },
  ]);
}

type Span = { text: string; fg?: string; bold?: boolean };

/**
 * One header row: something on the left, something on the right, and the left clipped rather than
 * wrapped when the two would collide. A header that wraps is a header that moves the transcript.
 */
function Row(props: { left: Span[]; right: Span[]; width: number }): React.ReactNode {
  const room = Math.max(8, props.width - spanWidth(props.right) - 2);
  return (
    <box flexDirection="row" justifyContent="space-between" width={props.width}>
      <Line spans={clip(props.left, room)} />
      <Line spans={props.right} />
    </box>
  );
}

function Line(props: { spans: Span[] }): React.ReactNode {
  return (
    <text>
      {props.spans.map((span, index) => (
        <span
          key={index}
          {...(span.fg === undefined ? {} : { fg: span.fg })}
          {...(span.bold ? { attributes: createTextAttributes({ bold: true }) } : {})}
        >
          {span.text}
        </span>
      ))}
    </text>
  );
}

function spanWidth(spans: Span[]): number {
  return spans.reduce((sum, span) => sum + span.text.length, 0);
}

/** Clip to a hard column with an ellipsis, without losing the styling of what survives. */
function clip(spans: Span[], room: number): Span[] {
  if (spanWidth(spans) <= room) return spans;
  const out: Span[] = [];
  let left = Math.max(1, room - 1);
  for (const span of spans) {
    if (left <= 0) break;
    if (span.text.length <= left) {
      out.push(span);
      left -= span.text.length;
      continue;
    }
    out.push({ ...span, text: span.text.slice(0, left) });
    left = 0;
  }
  out.push({ text: "…", fg: theme.dim });
  return out;
}
