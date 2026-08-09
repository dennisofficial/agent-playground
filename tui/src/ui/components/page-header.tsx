import { useTerminalDimensions } from "@opentui/react";
import React from "react";
import { fitTrail } from "../../domain/trail.js";
import { theme } from "../theme.js";

export function PageHeader(props: {
  trail: string[];
  right?: string;
  width?: number;
  canBack?: boolean;
}): React.ReactNode {
  const { width: terminalWidth } = useTerminalDimensions();
  const width = props.width ?? terminalWidth;
  const right = props.right ?? "";
  const prefix = props.canBack ? "‹ " : "";

  // Two columns of breathing room between the trail and whatever is right-aligned, so the two never
  // read as one run-on line at a narrow width.
  const available = Math.max(8, width - right.length - prefix.length - 2);

  return (
    <box
      flexDirection="row"
      justifyContent="space-between"
      width={width}
      marginBottom={1}
    >
      <text fg={theme.dim}>
        {prefix}
        {fitTrail(props.trail, available)}
      </text>
      {right ? <text fg={theme.dim}>{right}</text> : null}
    </box>
  );
}
