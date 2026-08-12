import { createTextAttributes, type StyleDefinitionInput } from "@opentui/core";
import React from "react";
import {
  type DiffHunk,
  type DiffRow,
  diffRows,
  diffSign,
  EDiffLineKind,
  gutterWidth,
} from "../../../domain/tool-diff.js";
import { DIFF_COLLAPSED_LINES, truncate } from "../../../domain/truncate.js";
import { codeTheme } from "../../markdown/themes/index.js";
import type { DiffPalette } from "../../markdown/themes/index.js";
import { theme } from "../../theme.js";

/**
 * The patch under a file-editing tool call: what changed, where, in the file's own numbering.
 *
 * A tool result is otherwise a sentence — "Updated file" — and a sentence about an edit is the one
 * kind of tool output you cannot check. This is the exception that earns its lines on screen.
 *
 * Deliberately NOT syntax-highlighted, unlike the fenced blocks in `markdown/`. A diff already
 * spends colour on the axis that matters here (added / removed), and a second colour system laid
 * over the first turns a glanceable band into a Christmas tree. The web renderer highlights because
 * it has a whole pane; a transcript row has eight lines.
 */

/** `EDiffLineKind` values are the palette's keys by design; the map is what makes that a type. */
const PALETTE_KEY: Record<EDiffLineKind, keyof DiffPalette> = {
  [EDiffLineKind.added]: "added",
  [EDiffLineKind.removed]: "removed",
  [EDiffLineKind.context]: "context",
  [EDiffLineKind.gap]: "meta",
};

/** Left of the gutter: the same five columns every other line of tool detail is indented by. */
const INDENT = "     ";

/** Below this there is no room for a diff worth reading, so it does not try. */
const MIN_BAND = 16;

export function DiffView(props: {
  hunks: DiffHunk[];
  width: number;
  expanded: boolean;
}): React.ReactNode {
  const rows = diffRows(props.hunks);
  if (rows.length === 0) return null;

  const { shown, notice } = props.expanded
    ? { shown: rows, notice: null }
    : truncate(rows, DIFF_COLLAPSED_LINES);

  const gutter = gutterWidth(rows);
  // Indent + number + the space after it; everything left over is the band the code sits in.
  const band = Math.max(
    MIN_BAND,
    props.width - INDENT.length - gutter - 1,
  );

  // Padded to the longest line SHOWN, so a tint reads as a band across the block rather than a
  // smear that stops where the text does — and clipped to the band, because a wrapped diff line
  // loses the alignment that makes the gutter mean anything.
  const columns = Math.min(
    band,
    Math.max(...shown.map((row) => row.text.length + 2)),
  );

  return (
    <box flexDirection="column">
      {shown.map((row, index) => (
        <DiffLine
          key={index}
          row={row}
          gutter={gutter}
          columns={columns}
          palette={codeTheme.diff}
        />
      ))}
      {notice ? (
        <text fg={theme.dim}>
          {INDENT}
          {notice}
        </text>
      ) : null}
    </box>
  );
}

function DiffLine(props: {
  row: DiffRow;
  gutter: number;
  columns: number;
  palette: DiffPalette;
}): React.ReactNode {
  const { row } = props;
  const style: StyleDefinitionInput = props.palette[PALETTE_KEY[row.kind]];
  const number = (row.lineNo === null ? "" : String(row.lineNo)).padStart(
    props.gutter,
  );
  const body =
    row.kind === EDiffLineKind.gap
      ? "⋯"
      : fit(`${diffSign(row.kind)} ${row.text}`, props.columns, !!style.bg);

  return (
    // `wrapMode="none"` for the same reason the fenced diff renderer uses it: a diff line that
    // wraps puts code under the gutter and the block stops being readable as columns.
    <text wrapMode="none">
      {INDENT}
      <span fg={theme.dim}>{number} </span>
      <span
        fg={style.fg}
        bg={style.bg}
        // A span takes attributes as a bitmask, not the booleans a style definition carries.
        attributes={createTextAttributes(style)}
      >
        {body}
      </span>
    </text>
  );
}

/** Pad to the band (only where a background makes padding visible), clip to it always. */
function fit(text: string, columns: number, padded: boolean): string {
  if (text.length > columns) return `${text.slice(0, Math.max(0, columns - 1))}…`;
  return padded ? text.padEnd(columns) : text;
}
