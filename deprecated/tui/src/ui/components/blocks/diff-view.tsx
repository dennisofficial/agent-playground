import { createTextAttributes, pathToFiletype, type TextChunk } from "@opentui/core";
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
import { useHighlightedRows } from "../../hooks/use-highlighted-rows.js";
import { fitDiffChunks } from "../../markdown/highlight-rows.js";
import { codeTheme } from "../../markdown/themes/index.js";
import type { DiffRowPalette } from "../../markdown/themes/index.js";

/**
 * The patch under a file-editing tool call: what changed, where, in the file's own numbering.
 *
 * A tool result is otherwise a sentence — "Updated file" — and a sentence about an edit is the one
 * kind of tool output you cannot check. This is the exception that earns its lines on screen.
 *
 * Three signals share the row, on three channels that do not compete: a saturated BLOCK behind the
 * line number says which side the row is on, removed rows are DIMMED because luminance is the one
 * channel a highlighter never spends, and hue is left entirely to the syntax. See `DiffRowStyle` in
 * `themes/code-theme.ts` for why not a background wash, `domain/diff-layout.ts` for where the
 * columns fall, and `markdown/highlight-rows.ts` for what the highlighting knowingly gets wrong.
 */

export function DiffView(props: {
  hunks: DiffHunk[];
  width: number;
  expanded: boolean;
  /**
   * The edited file's path, which is the only thing that can name the language. Absent — an engine
   * that reported a patch without a path — simply means no colour, never a guess: a wrong grammar
   * highlights confidently and wrongly, which is worse than not highlighting at all.
   */
  path?: string;
}): React.ReactNode {
  const rows = diffRows(props.hunks);
  const { shown, notice } = props.expanded
    ? { shown: rows, notice: null }
    : truncate(rows, DIFF_COLLAPSED_LINES);

  const layout = diffLayout({ rows, shown, width: props.width });
  // Only the rows actually drawn are highlighted. Expanding re-keys the pass, which is correct: the
  // extra context changes what the grammar sees, and the collapsed result stays cached behind it.
  const highlighted = useHighlightedRows({
    lines: shown.map((row) => row.text),
    filetype: (props.path ? pathToFiletype(props.path) : null) ?? null,
  });

  if (rows.length === 0) return null;

  return (
    <box flexDirection="column">
      {shown.map((row, index) => (
        <DiffLine
          key={index}
          row={row}
          chunks={highlighted?.[index] ?? null}
          numbers={layout.numbers}
          columns={layout.columns}
          palette={codeTheme().diffRows}
        />
      ))}
      {notice ? (
        <text fg={codeTheme().diffRows.gap.content.fg}>
          {DIFF_INDENT}
          {notice}
        </text>
      ) : null}
    </box>
  );
}

function DiffLine(props: {
  row: DiffRow;
  chunks: readonly TextChunk[] | null;
  numbers: number;
  columns: number;
  palette: DiffRowPalette;
}): React.ReactNode {
  const { row } = props;
  const { gutter, content } = props.palette[row.kind];
  // The row's own style is a WEIGHT laid over the syntax colours, never a colour of its own, so it
  // becomes an attribute mask each chunk is OR'd with rather than an fg that would flatten them.
  const weight = createTextAttributes(content);

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
      <span fg={content.fg} bg={content.bg} attributes={weight}>
        {DIFF_SEPARATOR}
      </span>
      {row.kind === EDiffLineKind.gap ? (
        <span fg={content.fg} attributes={weight}>
          ⋯
        </span>
      ) : props.chunks ? (
        fitDiffChunks({ chunks: props.chunks, columns: props.columns }).map(
          (chunk, index) => (
            <span
              key={index}
              // The chunk's colour wins; the theme's content fg is only the fallback for text no
              // grammar captured.
              fg={chunk.fg ?? content.fg}
              bg={content.bg}
              attributes={(chunk.attributes ?? 0) | weight}
            >
              {chunk.text}
            </span>
          ),
        )
      ) : (
        <span fg={content.fg} bg={content.bg} attributes={weight}>
          {fitDiffText({
            text: row.text,
            columns: props.columns,
            padded: !!content.bg,
          })}
        </span>
      )}
    </text>
  );
}
