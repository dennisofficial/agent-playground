import { createTextAttributes } from "@opentui/core";
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
import type { DiffRowPalette } from "../../markdown/themes/index.js";

/**
 * The patch under a file-editing tool call: what changed, where, in the file's own numbering.
 *
 * A tool result is otherwise a sentence — "Updated file" — and a sentence about an edit is the one
 * kind of tool output you cannot check. This is the exception that earns its lines on screen.
 *
 * The row is drawn as two columns carrying two different signals, because the code itself is
 * syntax-highlighted and hue is therefore already spent: a saturated BLOCK behind the line number
 * says which side the row is on, and removed rows are DIMMED rather than tinted. See `DiffRowStyle`
 * in `themes/code-theme.ts` for why those two channels and not a background wash.
 *
 * The sign lives in that block rather than in front of the text, which is the other half of the
 * same decision: it keeps the content column a verbatim file line, so indentation reads true and a
 * highlighter can be handed the row without first being told to ignore a prefix.
 */

/** Left of the gutter: the same five columns every other line of tool detail is indented by. */
const INDENT = "     ";

/** The block is `<number> <sign>`; a plain column then separates it from the code. */
const SIGN_COLUMNS = 2;

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

  const numbers = gutterWidth(rows);
  // Indent + the block + the column that separates it from code; the rest is the band code sits in.
  const band = Math.max(
    MIN_BAND,
    props.width - INDENT.length - numbers - SIGN_COLUMNS - 1,
  );

  // Clipped to the band, because a wrapped diff line loses the alignment that makes the gutter mean
  // anything. Padded only to the longest line SHOWN, and only where a theme has set a content
  // background — neither shipped theme does, so ordinarily this costs nothing.
  const columns = Math.min(band, Math.max(...shown.map((row) => row.text.length)));

  return (
    <box flexDirection="column">
      {shown.map((row, index) => (
        <DiffLine
          key={index}
          row={row}
          numbers={numbers}
          columns={columns}
          palette={codeTheme.diffRows}
        />
      ))}
      {notice ? (
        <text fg={codeTheme.diffRows.gap.content.fg}>
          {INDENT}
          {notice}
        </text>
      ) : null}
    </box>
  );
}

function DiffLine(props: {
  row: DiffRow;
  numbers: number;
  columns: number;
  palette: DiffRowPalette;
}): React.ReactNode {
  const { row } = props;
  const { gutter, content } = props.palette[row.kind];
  const number = (row.lineNo === null ? "" : String(row.lineNo)).padStart(
    props.numbers,
  );
  const body =
    row.kind === EDiffLineKind.gap
      ? "⋯"
      : fit(row.text, props.columns, !!content.bg);

  return (
    // `wrapMode="none"` for the same reason the fenced diff renderer uses it: a diff line that
    // wraps puts code under the gutter and the block stops being readable as columns.
    <text wrapMode="none">
      {INDENT}
      <span
        fg={gutter.fg}
        bg={gutter.bg}
        // A span takes attributes as a bitmask, not the booleans a style definition carries.
        attributes={createTextAttributes(gutter)}
      >
        {number} {diffSign(row.kind)}
      </span>
      <span fg={content.fg} bg={content.bg} attributes={createTextAttributes(content)}>
        {` ${body}`}
      </span>
    </text>
  );
}

/** Pad to the band (only where a background makes padding visible), clip to it always. */
function fit(text: string, columns: number, padded: boolean): string {
  if (text.length > columns) return `${text.slice(0, Math.max(0, columns - 1))}…`;
  return padded ? text.padEnd(columns) : text;
}
