import React from "react";
import { glyph, theme } from "../theme.js";

export type OverlayItem = {
  id: string;
  label: string;
  hint?: string;
  detail?: string;
};

export function OverlayList(props: {
  items: OverlayItem[];
  selected: number;
  emptyMessage?: string;
  max?: number;
}): React.ReactNode {
  const max = props.max ?? 6;

  if (props.items.length === 0) {
    return (
      <box flexDirection="row">
        <text fg={theme.dim}>
          {"  "}
          {props.emptyMessage ?? "no matches"}
        </text>
      </box>
    );
  }

  // Keep the selection visible without moving the composer: window the list, don't grow it.
  const start = Math.max(
    0,
    Math.min(props.selected - max + 1, props.items.length - max),
  );
  const visible = props.items.slice(start, start + max);

  return (
    <box flexDirection="column">
      {visible.map((item, index) => {
        const isSelected = start + index === props.selected;
        return (
          <text key={item.id}>
            {isSelected ? (
              <span fg={theme.accent}>{`  ${glyph.selected} `}</span>
            ) : (
              "    "
            )}
            <span fg={isSelected ? undefined : theme.dim}>
              {item.label.padEnd(18)}
            </span>
            {item.hint ? <span fg={theme.dim}> {item.hint}</span> : null}
            {item.detail ? <span fg={theme.dim}> {item.detail}</span> : null}
          </text>
        );
      })}
    </box>
  );
}
