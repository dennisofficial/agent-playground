import { pathToFiletype, type TextChunk } from "@opentui/core";
import React from "react";
import { asInput, str } from "../../../domain/tool-summary.js";
import { EHit, hitKey, type GroupMember } from "../../../domain/tool-group.js";
import { wrapRanges } from "../../../domain/truncate.js";
import { useHighlightedRows } from "../../hooks/use-highlighted-rows.js";
import { theme } from "../../theme.js";

/** Source lines of output a closed body shows before offering the rest. */
const OUTPUT_LINES = 6;

/** Left of an opened call's body, two columns deeper than the rows it hangs under. */
const INDENT = "       ";

/**
 * What a body needs in order to be clicked and hovered.
 *
 * Passed down rather than owned here, because hover is one pointer position for the whole block: two
 * components tracking it separately would let a row and its body light up independently, which is the
 * opposite of the rule that a thing and its body are one thing.
 */
export type DetailInteraction = {
  hovered: string | null;
  setHovered: (key: string | null) => void;
  onToggle: (key: string) => void;
  expanded: ReadonlySet<string>;
};

/**
 * One call, opened: its command, then what it said.
 *
 * This is what a group costs the reader and what pays it back — the row says WHICH command ran, and one
 * click says what it was and what came back. Bash is the case that needs it most: the header carries
 * the model's description, so without this the command itself would be nowhere.
 *
 * ## Highlighting, and the shell rule
 *
 * A shell transcript colours the COMMAND and leaves the OUTPUT plain, because output is not source in
 * any language and a grammar applied to it invents structure that is not there. So the command is
 * highlighted as `bash` and everything below it is dim text — which is also what a real terminal looks
 * like, and the reason the two are separate passes rather than one.
 *
 * A Read's output IS source, and is highlighted by the file's own filetype. `Write`/`Edit` never reach
 * here: they are `standalone`, so their patch draws through `DiffView` exactly as before.
 *
 * ## Two levels, because output is unbounded
 *
 * A command can print ten thousand lines. Opening a call shows `OUTPUT_LINES` of them and offers the
 * rest on `… +N lines`, which is a click of its own — a second LEVEL rather than a second gesture, so
 * the same open-it-then-click-it-again-to-close rule applies.
 */
export function ToolDetail(props: {
  member: GroupMember;
  /** Columns the body may use, already inset. */
  width: number;
  ui: DetailInteraction;
}): React.ReactNode {
  const { member, ui } = props;
  const band = Math.max(8, props.width - INDENT.length);
  const result = member.result;

  const outputKey = hitKey(EHit.output, member.payload.toolUseId);
  const all = result?.detail ?? [];
  const showAll = ui.expanded.has(outputKey);
  const shown = showAll ? all : all.slice(0, OUTPUT_LINES);
  const hidden = all.length - shown.length;

  const outputRows = useHighlightedRows({
    lines: shown,
    filetype: outputFiletype(member),
  });

  const handlers = {
    onMouseDown: () => ui.onToggle(outputKey),
    onMouseOver: () => ui.setHovered(outputKey),
    onMouseOut: () => ui.setHovered(null),
  };

  return (
    <box flexDirection="column">
      <CommandLines command={member.view.command} width={props.width} />

      {/* A FAILURE has no detail to show: `summariseToolResult` puts the first line into `summary` and
          hands back `lines.slice(1)`, which for a one-line error is empty. So a failed Read opened to
          nothing at all, and "failed HOW?" — the one thing the reader wanted — was the one thing thrown
          away. The row's measure says `failed`; this says why. */}
      {result && !result.ok ? (
        <DetailLine text={result.summary} band={band} chunks={null} fg={theme.error} />
      ) : null}

      {shown.map((line, index) => (
        <DetailLine
          key={index}
          text={line}
          band={band}
          chunks={outputRows?.[index] ?? null}
          fg={theme.dim}
        />
      ))}

      {hidden > 0 || showAll ? (
        <text wrapMode="none" {...handlers}>
          <span
            fg={theme.dim}
            {...(ui.hovered === outputKey ? { bg: theme.hoverBg } : {})}
          >
            {INDENT}
            {showAll ? `… ${all.length} lines, all shown` : `… +${hidden} lines`}
          </span>
        </text>
      ) : null}

      {/* Never nothing: a click that draws no row is indistinguishable from a click that missed. */}
      {member.view.command.length === 0 && all.length === 0 && result?.ok !== false ? (
        <text fg={theme.dim} wrapMode="none">
          {INDENT}(no output)
        </text>
      ) : null}
    </box>
  );
}

/**
 * A command, syntax-highlighted as `bash` and WRAPPED.
 *
 * Shared by the grouped body and by a lone Bash block, so the two cannot drift into showing the same
 * command two different ways — the header shows the model's description in both cases, which makes this
 * the only place the command itself appears, and the reason it may not be clipped.
 */
export function CommandLines(props: {
  command: readonly string[];
  width: number;
}): React.ReactNode {
  const band = Math.max(8, props.width - INDENT.length);
  const rows = useHighlightedRows({
    lines: props.command,
    filetype: props.command.length > 0 ? "bash" : null,
  });
  return (
    <>
      {props.command.map((line, index) => (
        <DetailLine
          key={index}
          text={line}
          band={band}
          chunks={rows?.[index] ?? null}
          fg={theme.codeInline}
        />
      ))}
    </>
  );
}

/**
 * One line of body, wrapped whether or not a grammar coloured it.
 *
 * The coloured path wraps by cutting CHUNKS at the boundaries `wrapRanges` reports. Clipping coloured
 * lines and wrapping only plain ones was cheaper, and is what this did first — but the one line that
 * most needs reading in full is the command, which is exactly the line that gets highlighted. Clipping
 * it hid half of every real pipeline.
 */
function DetailLine(props: {
  text: string;
  band: number;
  chunks: readonly TextChunk[] | null;
  fg: string;
}): React.ReactNode {
  const ranges = wrapRanges(props.text, props.band);
  const chunks = props.chunks;

  if (!chunks) {
    return (
      <>
        {ranges.map((range, index) => (
          <text key={index} fg={props.fg} wrapMode="none">
            {INDENT}
            {props.text.slice(range.start, range.end)}
          </text>
        ))}
      </>
    );
  }

  return (
    <>
      {ranges.map((range, rowIndex) => (
        <text key={rowIndex} wrapMode="none">
          {INDENT}
          {sliceChunks(chunks, range.start, range.end).map((chunk, index) => (
            <span key={index} fg={chunk.fg ?? props.fg} attributes={chunk.attributes ?? 0}>
              {chunk.text}
            </span>
          ))}
        </text>
      ))}
    </>
  );
}

/** The chunks covering `[start, end)` of the line they were highlighted from, cut at both edges. */
function sliceChunks(
  chunks: readonly TextChunk[],
  start: number,
  end: number,
): readonly TextChunk[] {
  const out: TextChunk[] = [];
  let at = 0;
  for (const chunk of chunks) {
    const chunkEnd = at + chunk.text.length;
    if (chunkEnd > start && at < end) {
      out.push({
        ...chunk,
        text: chunk.text.slice(Math.max(0, start - at), Math.min(chunk.text.length, end - at)),
      });
    }
    at = chunkEnd;
    if (at >= end) break;
  }
  return out;
}

/**
 * The grammar for a call's OUTPUT, or `null` for "leave it plain".
 *
 * Only a file read has output that is source. A command's output is not source in any language, and a
 * search's output is a list of matches from many files — colouring either invents structure the text
 * does not have, and a confident wrong highlight reads worse than none.
 */
function outputFiletype(member: GroupMember): string | null {
  if (member.payload.name !== "Read" && member.payload.name !== "NotebookRead") return null;
  const input = asInput(member.payload.input);
  const path = str(input.file_path) ?? str(input.path) ?? str(input.notebook_path);
  return path === undefined ? null : (pathToFiletype(path) ?? null);
}
