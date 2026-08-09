import React from "react";
import { infoStringToFiletype } from "@opentui/core";
import { codeSyntaxStyleFor } from "../syntax-style.js";
import type { FencedBlockView, FencedRenderer } from "../registry.js";

function view(
  source: string,
  language: string,
  width: number,
): FencedBlockView {
  const lines = source.split("\n");
  const filetype = infoStringToFiletype(language) ?? language;
  const columns = Math.max(0, ...lines.map((line) => line.length));

  return {
    // Two properties, one job: keep the node at the width it was GIVEN, and let it overflow that
    // width internally rather than reflowing to it. `wrapMode="none"` stops a long line wrapping,
    // and the explicit width stops flex stretching a short block — with either missing the buffer
    // has no columns beyond its viewport, `scrollX` has zero range, and the wheel falls through to
    // the transcript. That is the reported "← → scrolls vertically".
    node: (
      <code
        content={source}
        filetype={filetype}
        // Per filetype, because a theme corrects some scopes per language — a YAML key and a
        // JavaScript member access are the same capture and different colours.
        syntaxStyle={codeSyntaxStyleFor(filetype)}
        wrapMode="none"
        width={Math.min(columns, width)}
        flexShrink={0}
      />
    ),
    // The natural width is the longest line. The block scrolls sideways past this rather than
    // wrapping, because wrapped code stops being readable as code.
    columns,
    rows: lines.length,
  };
}

export const codeRenderer: FencedRenderer = {
  name: "code",
  // Claims any labelled fence. Unlabelled fences fall through to the plain renderer, because
  // handing Tree-sitter an empty filetype produces worse output than leaving the text alone.
  handles: (language) => language.length > 0,
  render: (source, language, width) => view(source, language, width),
};

/** Unlabelled fences: no grammar to apply, so this is just monospaced text in a block. */
export const plainRenderer: FencedRenderer = {
  name: "plain",
  handles: () => true,
  render: (source, _language, width) => {
    const lines = source.split("\n");
    const columns = Math.max(0, ...lines.map((line) => line.length));
    return {
      // Unwrapped and explicitly sized for the same reason as code: a fence is preformatted by
      // definition, and the block only has something to pan if its buffer keeps its own width.
      node: (
        <text wrapMode="none" width={Math.min(columns, width)} flexShrink={0}>
          {source}
        </text>
      ),
      columns,
      rows: lines.length,
    };
  },
};
