import React from "react";
import { createTextAttributes, type StyleDefinitionInput } from "@opentui/core";
import { codeTheme } from "../themes/index.js";
import type { DiffPalette } from "../themes/index.js";
import type { FencedBlockView, FencedRenderer } from "../registry.js";

type DiffLineKind = keyof DiffPalette;

export function classifyDiffLine(line: string): DiffLineKind {
  if (line.startsWith("+++") || line.startsWith("---")) return "meta";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "added";
  if (line.startsWith("-")) return "removed";
  // `diff --git`, `index abc..def`, `new file mode`, `similarity index` — everything git puts
  // between one file's hunks and the next. Anything else is context.
  if (
    /^(diff |index |new file |deleted file |old mode|new mode|similarity |rename |Binary )/.test(
      line,
    )
  ) {
    return "meta";
  }
  return "context";
}

function view(
  source: string,
  width: number,
  palette: DiffPalette,
): FencedBlockView {
  const lines = source.split("\n");
  const columns = Math.max(0, ...lines.map((line) => line.length));

  return {
    // ONE `<text>`, not a column of them: the descriptor's node has to be a single text-buffer
    // element or `TextPanner` has nothing to pan, and a wide diff is exactly the block that pans.
    // Per-line colour comes from spans inside that one buffer.
    node: (
      <text wrapMode="none" width={Math.min(columns, width)} flexShrink={0}>
        {lines.map((line, index) => {
          const style: StyleDefinitionInput = palette[classifyDiffLine(line)];
          // Padded to the block's natural width so a tinted line reads as a band across the block
          // rather than a smear that stops where the text does. Without a `bg` the padding is
          // invisible, so themes that decline to tint pay nothing for it.
          const text = style.bg ? line.padEnd(columns) : line;
          return (
            <span
              key={index}
              fg={style.fg}
              bg={style.bg}
              // A span takes attributes as a bitmask, not as the booleans a `StyleDefinitionInput`
              // carries — `createTextAttributes` is the same translation the syntax styles get.
              attributes={createTextAttributes(style)}
            >
              {index === lines.length - 1 ? text : `${text}\n`}
            </span>
          );
        })}
      </text>
    ),
    columns,
    rows: lines.length,
  };
}

export const diffRenderer: FencedRenderer = {
  name: "diff",
  // `patch` is the other name the same content arrives under.
  handles: (language) => language === "diff" || language === "patch",
  render: (source, _language, width) => view(source, width, codeTheme.diff),
};
