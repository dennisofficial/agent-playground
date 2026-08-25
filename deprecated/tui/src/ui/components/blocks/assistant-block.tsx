import { useTerminalDimensions } from "@opentui/react";
import React from "react";
import { stripCanary } from "../../../domain/canary.js";
import { MarkdownView } from "../../markdown/markdown-view.js";
import { glyph, theme, TRANSCRIPT_INSET } from "../../theme.js";

const GUTTER = 2;
const RESERVED = GUTTER + TRANSCRIPT_INSET;

export function AssistantBlock(props: {
  text: string;
  streaming?: boolean;
  interrupted?: boolean;
}): React.ReactNode {
  const { width } = useTerminalDimensions();
  // Stripped HERE and never in the store: the canary is watched for its absence, so the raw bytes
  // have to survive. Applying it to the block covers the live tail too — the tail accumulates the
  // whole text, so the leading glyph is leading in both.
  const text = stripCanary(props.text);

  return (
    <box flexDirection="column" marginBottom={1}>
      <box flexDirection="row">
        <text fg={theme.accent}>{glyph.block} </text>
        <box flexDirection="column" flexGrow={1} flexShrink={1} flexBasis={0}>
          <MarkdownView
            source={text}
            width={Math.max(1, width - RESERVED)}
            streaming={props.streaming}
          />
        </box>
      </box>
      {props.interrupted ? (
        <text fg={theme.dim}> Interrupted by user</text>
      ) : null}
    </box>
  );
}
