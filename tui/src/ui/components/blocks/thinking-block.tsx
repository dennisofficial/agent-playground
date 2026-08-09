import React from "react";
import { thinkingSummary } from "../../../domain/truncate.js";
import { glyph, theme } from "../../theme.js";

export function ThinkingBlock(props: {
  text: string;
  streaming?: boolean;
  expanded?: boolean;
}): React.ReactNode {
  if (!props.streaming && !props.expanded) {
    return (
      <box flexDirection="row" marginBottom={1}>
        <text fg={theme.dim}>
          {glyph.thinking} {thinkingSummary(props.text)}
        </text>
      </box>
    );
  }

  const lines = props.text.split("\n");
  return (
    <box flexDirection="column" marginBottom={1}>
      <text fg={theme.dim}>{glyph.thinking} Thinking…</text>
      <text> </text>
      {lines.map((line, index) => (
        <text key={index} fg={theme.dim}>
          {"  "}
          {line}
          {props.streaming && index === lines.length - 1 ? (
            <span>▌</span>
          ) : null}
        </text>
      ))}
    </box>
  );
}
