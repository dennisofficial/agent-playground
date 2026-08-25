import React from "react";
import { glyph, theme } from "../theme.js";

export function ConfirmBar(props: {
  question: string;
  detail?: string;
  confirmLabel?: string;
}): React.ReactNode {
  return (
    <box flexDirection="column">
      <text fg={theme.warn}>
        {"  "}
        {glyph.warning} {props.question}
      </text>
      {props.detail ? (
        <text fg={theme.dim}>
          {"    "}
          {props.detail}
        </text>
      ) : null}
      <text fg={theme.dim}>
        {"  "}y {props.confirmLabel ?? "delete"} · n cancel
      </text>
    </box>
  );
}
