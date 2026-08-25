import React from "react";
import { glyph, theme } from "../theme.js";

/**
 * The shared atoms of a list page. They exist as components rather than as copied JSX because the
 * selection caret is a CONVENTION — four cells wide whether or not the row is selected, so the
 * columns after it do not shift as the cursor moves. Every page that reimplemented it was one
 * character away from making the list jitter.
 */

/** Renders inside a `<text>`, so it is a span or a plain string — never a `<text>` of its own. */
export function Caret(props: { on: boolean }): React.ReactNode {
  if (!props.on) return "    ";
  return <span fg={theme.accent}>{`  ${glyph.selected} `}</span>;
}

/** The list has nothing in it yet. Says what the thing IS, not just that there are none. */
export function ListEmpty(props: {
  show: boolean;
  headline: string;
  hint: string;
}): React.ReactNode {
  if (!props.show) return null;
  return (
    <box flexDirection="column">
      <text>{props.headline}</text>
      <text fg={theme.dim}>{props.hint}</text>
      <text> </text>
    </box>
  );
}

/**
 * A filter matched nothing. Distinct from `ListEmpty` on purpose: "no jobs" and "no jobs matching
 * `foo`" are different problems, and only one of them is fixed by typing less.
 */
export function NoMatch(props: { show: boolean; query: string }): React.ReactNode {
  if (!props.show) return null;
  return (
    <box flexDirection="column">
      <text fg={theme.dim}>
        {"    "}Nothing matches “{props.query}”.
      </text>
      <text> </text>
    </box>
  );
}

/**
 * The trailing `+ new job` affordance. It is a selectable ROW, not a hint: the cursor can land past
 * the last item, which is what makes an empty list navigable with the same keys as a full one.
 */
export function AddRow(props: { selected: boolean; label: string }): React.ReactNode {
  return (
    <text>
      <Caret on={props.selected} />
      <span fg={theme.dim}>{props.label}</span>
    </text>
  );
}
