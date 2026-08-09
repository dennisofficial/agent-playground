import React from "react";
import { glyph, theme } from "../../theme.js";

export function UserBlock(props: { text: string }): React.ReactNode {
  return (
    <box flexDirection="column" marginBottom={1} backgroundColor={theme.userBg}>
      {props.text.split("\n").map((line, index) => (
        <text key={index} fg={theme.userFg}>
          {index === 0 ? `${glyph.user} ` : "  "}
          {line}
        </text>
      ))}
    </box>
  );
}
