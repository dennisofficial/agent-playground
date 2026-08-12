import React from "react";
import { OverlayList, type OverlayItem } from "./overlay-list.js";
import { theme } from "../theme.js";

const INDENT = "  ";

/**
 * A titled menu in a list page's footer — how Dennis starts a phase and opens a thread.
 *
 * A footer menu rather than a modal, for the reason the confirm overlay is one: these are one
 * keypress in a loop that costs a keypress a lap by design, and a dialog for it would be three. It
 * borrows `OverlayList` outright so the selection reads identically to the command palette; the only
 * thing this adds is a heading, because a bare list of phase names says nothing about which job or
 * which phase it is about to act on.
 */
export function VerbMenu(props: {
  title: string;
  items: OverlayItem[];
  selected: number;
  caption: string;
  /** How many rows the menu may take. Nine phases do not fit a short terminal. */
  max?: number;
  error?: string | null;
}): React.ReactNode {
  return (
    <box flexDirection="column">
      <text fg={theme.accent}>
        {INDENT}
        {props.title}
      </text>

      <OverlayList
        items={props.items}
        selected={props.selected}
        max={props.max ?? 7}
        // A phase that hosts no roles declares none and forbids threads by construction — there is
        // no flag to check, so this line IS the refusal. No phase does today.
        emptyMessage="this phase hosts no threads"
      />

      <text fg={theme.dim}>
        {INDENT}
        {props.caption}
      </text>

      {props.error ? (
        <text fg={theme.error}>
          {INDENT}
          {props.error}
        </text>
      ) : null}
    </box>
  );
}
