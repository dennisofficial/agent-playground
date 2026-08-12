import React from "react";
import { stripCanary } from "../../../domain/canary.js";
import { thinkingSummary } from "../../../domain/truncate.js";
import { glyph, theme } from "../../theme.js";

export function ThinkingBlock(props: {
  text: string;
  streaming?: boolean;
  expanded?: boolean;
}): React.ReactNode {
  // Every prose surface strips, not just the assistant one — an agent that opens its thinking with
  // the glyph should read the same as one that opens its answer with it. See `domain/canary.ts`.
  const text = stripCanary(props.text);

  if (!props.streaming && !props.expanded) {
    return (
      <box flexDirection="row" marginBottom={1}>
        <text fg={theme.dim}>
          {glyph.thinking} {thinkingSummary(text)}
        </text>
      </box>
    );
  }

  const lines = text.split("\n");
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
