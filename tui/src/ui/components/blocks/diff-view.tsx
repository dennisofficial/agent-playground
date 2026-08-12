import { createTextAttributes } from "@opentui/core";
import React from "react";
import {
  DIFF_INDENT,
  DIFF_SEPARATOR,
  diffGutterText,
  diffLayout,
  fitDiffText,
} from "../../../domain/diff-layout.js";
import {
  type DiffHunk,
  type DiffRow,
  diffRows,
  EDiffLineKind,
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
 * in `themes/code-theme.ts` for why those two channels and not a background wash, and
 * `domain/diff-layout.ts` for where the columns fall.
 */

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

  const layout = diffLayout({ rows, shown, width: props.width });

  return (
    <box flexDirection="column">
      {shown.map((row, index) => (
        <DiffLine
          key={index}
          row={row}
          numbers={layout.numbers}
          columns={layout.columns}
          palette={codeTheme.diffRows}
        />
      ))}
      {notice ? (
        <text fg={codeTheme.diffRows.gap.content.fg}>
          {DIFF_INDENT}
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
  const body =
    row.kind === EDiffLineKind.gap
      ? "⋯"
      : fitDiffText({
          text: row.text,
          columns: props.columns,
          padded: !!content.bg,
        });

  return (
    // `wrapMode="none"` for the same reason the fenced diff renderer uses it: a diff line that
    // wraps puts code under the gutter and the block stops being readable as columns.
    <text wrapMode="none">
      {DIFF_INDENT}
      <span
        fg={gutter.fg}
        bg={gutter.bg}
        // A span takes attributes as a bitmask, not the booleans a style definition carries.
        attributes={createTextAttributes(gutter)}
      >
        {diffGutterText(row, props.numbers)}
      </span>
      <span
        fg={content.fg}
        bg={content.bg}
        attributes={createTextAttributes(content)}
      >
        {DIFF_SEPARATOR}
        {body}
      </span>
    </text>
  );
}
