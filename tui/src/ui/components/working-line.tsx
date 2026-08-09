import React from "react";
import type { QueuedSteer } from "../../app/conversation.store.js";
import { formatElapsed, formatTokens, glyph, theme } from "../theme.js";

export function WorkingLine(props: {
  running: boolean;
  elapsedMs: number;
  frame: string;
  outputTokens: number;
  queued: QueuedSteer[];
  interrupting: boolean;
}): React.ReactNode {
  const elapsed = formatElapsed(props.elapsedMs);
  // ↓, not ↑: this counts what came DOWN from the model. Up is what we sent it.
  const tokens =
    props.outputTokens > 0
      ? `↓ ${formatTokens(props.outputTokens)} tokens`
      : "";
  // Running, the parenthetical always has the escape hatch in it; finished, it is tokens or nothing.
  const detail = props.running
    ? `${tokens ? `${tokens} · ` : ""}esc to interrupt`
    : tokens;

  return (
    <box flexDirection="column">
      <text fg={theme.dim}>
        <span fg={props.running ? theme.accent : theme.dim}>
          {props.interrupting ? props.frame : glyph.thinking}
        </span>{" "}
        {props.interrupting
          ? "Interrupting…"
          : `${props.running ? "Working" : "Worked"} for ${elapsed}`}
        {props.interrupting || !detail ? "" : ` (${detail})`}
      </text>
      {props.queued.map((steer) => (
        <text key={steer.id} fg={theme.dim}>
          {"  "}
          {glyph.queued} {steer.text}
        </text>
      ))}
    </box>
  );
}
