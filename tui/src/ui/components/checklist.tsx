import React from "react";
import {
  checklistView,
  clipTaskText,
  ESpineMark,
  type TaskView,
} from "../../domain/tasks.js";
import { ETaskStatus } from "../../generated/prisma/enums.js";
import { theme } from "../theme.js";

/**
 * Rows the panel will draw before it starts hiding them. Small on purpose: this sits between the
 * transcript and the composer, and a fifteen-step plan would push the conversation it describes off
 * the screen. `checklistView` picks WHICH rows, anchored on the work rather than on the top.
 */
export const CHECKLIST_ROWS = 4;

/**
 * The rail, one cell wide, running down the left of the plan.
 *
 * A dashed segment means the list carries on past the window; a cap means it genuinely ends there.
 * That distinction is the whole reason the panel can be four rows tall without lying about a
 * fifteen-step plan — and it is drawn, not counted, so it costs a glance rather than a read.
 */
const MARK: Record<ESpineMark, string> = {
  [ESpineMark.live]: "▶",
  [ESpineMark.continues]: "┆",
  [ESpineMark.head]: "╷",
  [ESpineMark.tail]: "╵",
  [ESpineMark.through]: "│",
};

/**
 * Two recessed greys, deliberately the footer meters' own (`meter-style.ts`): the rail and a spent
 * task are furniture in exactly the way a meter's empty track is, and a checklist that invented its
 * own greys would read as a second instrument sitting next to the first.
 *
 * The live row takes `theme.hover` — the brightest neutral in the app — because the panel's entire
 * job is to make one row out of four findable without reading the other three.
 */
const RAIL = "#343434";
const PENDING = "#5c5c5c";

/**
 * Columns before a row's text: a leading space, the rail, three for the count, one of air. Fixed, so
 * no row's text shifts sideways when a count appears, grows a digit, or drops off the end.
 */
const GUTTER = 6;

/**
 * The agent's plan, in the thread, where Dennis is already looking.
 *
 * It renders itself out of existence when there are no tasks: an empty panel above the composer
 * would cost a row of transcript on every thread to say nothing. That is also the whole of its
 * interaction design — nothing to press, nothing to toggle. The list appears when the agent writes
 * one down and moves while it works.
 */
export function Checklist(props: {
  tasks: readonly TaskView[];
  width: number;
  maxRows?: number;
}): React.ReactNode {
  const rows = checklistView({
    tasks: props.tasks,
    maxRows: props.maxRows ?? CHECKLIST_ROWS,
  });
  if (rows.length === 0) return null;

  const textWidth = Math.max(8, props.width - GUTTER);

  return (
    <box flexDirection="column" width={props.width}>
      {rows.map((row) => {
        const live = row.mark === ESpineMark.live;
        return (
          <text key={row.ordinal}>
            <span> </span>
            <span fg={live ? theme.accent : RAIL}>{MARK[row.mark]}</span>
            <span fg={RAIL}>{badge(row.hidden)}</span>
            <span> </span>
            <span
              fg={
                live
                  ? theme.hover
                  : row.status === ETaskStatus.completed
                    ? RAIL
                    : PENDING
              }
            >
              {clipTaskText(row.text, textWidth)}
            </span>
          </text>
        );
      })}
    </box>
  );
}

/**
 * The count in the gutter, in exactly three cells or three spaces — never more, or it would push the
 * text of one row out of line with the rest. A plan long enough to overflow `+99` has bigger
 * problems than the badge, so it saturates rather than widening.
 */
function badge(hidden: number): string {
  if (hidden <= 0) return "   ";
  return (hidden > 99 ? "99+" : `+${hidden}`).padEnd(3, " ");
}
