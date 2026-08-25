import React, { useMemo } from "react";
import { segmentMarkdown } from "../../domain/markdown/segment.js";
import { ALT, glyph, theme } from "../theme.js";
import { proseSyntaxStyle } from "./syntax-style.js";
import { CopyButton } from "./copy-button.js";
import { FencedBlock } from "./fenced-block.js";
import { HorizontalScroller } from "./horizontal-scroller.js";
import {
  registerFallbackRenderer,
  registerFencedRenderer,
} from "./registry.js";
import { codeRenderer, plainRenderer } from "./renderers/code.js";
import { diffRenderer } from "./renderers/diff.js";
import { measureTable, TABLE_OPTIONS } from "./table-metrics.js";

// Order is precedence, and `codeRenderer` claims ANY labelled fence — so anything with a narrower
// claim has to be registered ahead of it.
registerFencedRenderer(diffRenderer);
registerFencedRenderer(codeRenderer);
registerFallbackRenderer(plainRenderer);

export function MarkdownView(props: {
  source: string;
  width: number;
  streaming?: boolean;
  /**
   * The colours the HOST is drawing in, for a block that renders prose over a slab of its own — the
   * harness's. `proseSyntaxStyle` deliberately leaves `default` unstyled so prose inherits its
   * foreground, and a wrapped line has to paint the slab under itself rather than leave a hole in
   * it, so both have to reach `<markdown>` explicitly. Omitted everywhere else, which is the
   * transcript's normal case: transparent over whatever the terminal already has.
   */
  fg?: string;
  bg?: string;
}): React.ReactNode {
  const segments = useMemo(() => segmentMarkdown(props.source), [props.source]);
  const colours = {
    ...(props.fg === undefined ? {} : { fg: props.fg }),
    ...(props.bg === undefined ? {} : { bg: props.bg }),
  };

  // A fence and a table are structural: a caret appended to either would be lexed as content — a
  // last line of code, a fourth column — instead of drawn after it. Those two keep the caret on
  // the line below, which is the honest place for it when the block itself owns the last row.
  const trailing =
    props.streaming === true && segments[segments.length - 1]?.kind !== "prose";

  return (
    <box flexDirection="column">
      {segments.map((segment, index) => {
        // Only the LAST segment is still growing — see `streaming` on `<markdown>`. Everything
        // before it is closed by construction (a segment ends because something else began), so
        // leaving those stable keeps the incremental parser doing its job.
        const live = props.streaming === true && index === segments.length - 1;

        return segment.kind === "table" ? (
          <TableBlock
            key={index}
            markdown={segment.markdown}
            width={props.width}
            streaming={live}
            {...colours}
          />
        ) : segment.kind === "fence" ? (
          <FencedBlock
            key={index}
            language={segment.language}
            source={segment.source}
            width={props.width}
          />
        ) : (
          <markdown
            key={index}
            content={live ? withCaret(segment.text) : segment.text}
            syntaxStyle={proseSyntaxStyle()}
            width={props.width}
            streaming={live}
            {...colours}
          />
        );
      })}
      {trailing ? <text>{glyph.caret}</text> : null}
    </box>
  );
}

function withCaret(text: string): string {
  return `${text.replace(/\s+$/, "")}${glyph.caret}`;
}

function TableBlock(props: {
  markdown: string;
  width: number;
  streaming?: boolean;
  fg?: string;
  bg?: string;
}): React.ReactNode {
  const metrics = useMemo(() => measureTable(props.markdown), [props.markdown]);
  const table = (
    <markdown
      content={props.markdown}
      syntaxStyle={proseSyntaxStyle()}
      tableOptions={TABLE_OPTIONS}
      width={metrics.columns}
      flexShrink={0}
      streaming={props.streaming}
      {...(props.fg === undefined ? {} : { fg: props.fg })}
      {...(props.bg === undefined ? {} : { bg: props.bg })}
    />
  );

  if (metrics.columns <= props.width) return table;

  // The bounding box is what keeps the scroller from growing the transcript: a scroll container
  // that sizes to its content pushes its parent past the viewport, and neighbouring blocks then
  // draw over each other. Width here, height inside the scroller.
  return (
    <box
      flexDirection="column"
      width={props.width}
      flexShrink={0}
      marginBottom={1}
    >
      <HorizontalScroller rows={metrics.rows}>{table}</HorizontalScroller>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.dim}>{`⇄ ${ALT}+wheel · ${metrics.columns} cols`}</text>
        {/* The source, not the drawn grid: a table pasted elsewhere should be a table again. */}
        <CopyButton text={props.markdown} />
      </box>
    </box>
  );
}
