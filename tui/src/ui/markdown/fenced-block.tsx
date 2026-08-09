import { BorderChars } from "@opentui/core";
import React from "react";
import { ALT, theme } from "../theme.js";
import { COPY_BUTTON_WIDTH, CopyButton } from "./copy-button.js";
import { rendererFor } from "./registry.js";
import { TextPanner } from "./text-panner.js";

const BORDER = 2;

export const CONTENT_PADDING = 1;

/** Everything between the block's outer edge and the room its content actually gets. */
const CHROME = BORDER + CONTENT_PADDING * 2;

/** Breathing room between the block's right edge and the terminal's, so it is not flush. */
const RIGHT_MARGIN = 2;

const CHARS = BorderChars.rounded;

export function FencedBlock(props: {
  language: string;
  source: string;
  width: number;
}): React.ReactNode {
  // The box is pinned to an explicit width. Without one it sizes to its CONTENT, so a wide fence
  // grows past the viewport and takes its right border off-screen with it — the border looks
  // missing when it is really just beyond the edge.
  const available = Math.max(4, props.width - RIGHT_MARGIN);

  // The border eats a column on each side, so the content has less room than the box — and it is
  // the CONTENT width that decides whether the block overflows. The renderer is told this width
  // rather than the block's, because it sizes its buffer to exactly the room it has.
  const renderer = rendererFor(props.language);
  const view = renderer.render(
    props.source,
    props.language,
    Math.max(1, available - CHROME),
  );

  const outer = Math.min(
    available,
    Math.max(view.columns + CHROME, headerColumns(props.language)),
  );
  const inner = Math.max(1, outer - CHROME);
  const overflows = view.columns > inner;

  return (
    <box flexDirection="column" marginBottom={1} width={outer} flexShrink={0}>
      <FenceHeader
        language={props.language}
        source={props.source}
        width={outer}
      />

      <box
        flexDirection="column"
        border={["left", "right", "bottom"]}
        borderStyle="rounded"
        borderColor={theme.dim}
        paddingX={CONTENT_PADDING}
      >
        {overflows ? (
          <TextPanner columns={view.columns} width={inner} rows={view.rows}>
            {view.node as React.ReactElement}
          </TextPanner>
        ) : (
          view.node
        )}

        {overflows ? (
          <text fg={theme.dim}>{`⇄ ${ALT}+wheel · ${view.columns} cols`}</text>
        ) : null}
      </box>
    </box>
  );
}

function headerLabel(language: string): string {
  return language.length > 0
    ? `${CHARS.topLeft}${CHARS.horizontal} ${language} `
    : CHARS.topLeft;
}

function headerColumns(language: string): number {
  return headerLabel(language).length + COPY_BUTTON_WIDTH + 2;
}

function FenceHeader(props: {
  language: string;
  source: string;
  width: number;
}): React.ReactNode {
  const label = headerLabel(props.language);
  const right = `${CHARS.horizontal}${CHARS.topRight}`;
  const fill = props.width - label.length - COPY_BUTTON_WIDTH - right.length;

  // Too narrow to hold a button as well as a language: the border stays unbroken rather than
  // wrapping onto a second line and tearing the box open.
  if (fill < 0) {
    return (
      <text fg={theme.dim}>
        {label +
          CHARS.horizontal.repeat(Math.max(0, props.width - label.length - 1)) +
          CHARS.topRight}
      </text>
    );
  }

  return (
    <box flexDirection="row" width={props.width}>
      <text fg={theme.dim}>{label + CHARS.horizontal.repeat(fill)}</text>
      <CopyButton text={props.source} pad={CHARS.horizontal} />
      <text fg={theme.dim}>{right}</text>
    </box>
  );
}
