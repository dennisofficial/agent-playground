import React from "react";
import { checklistView, clipTaskText, type TaskView } from "../../domain/tasks.js";
import { ETaskStatus } from "../../generated/prisma/enums.js";
import { theme } from "../theme.js";

/**
 * Rows the panel will draw before it starts hiding them. Small on purpose: this sits between the
 * transcript and the composer, and a fifteen-step plan would push the conversation it describes off
 * the screen. `checklistView` picks WHICH rows, anchored on the work rather than on the top.
 */
export const CHECKLIST_ROWS = 5;

/**
 * A status, in one cell. Not new glyphs: `○` and `⏺` already mean *available* and *active* in the
 * lists, and a check is the one shape nobody has to be taught. The colour repeats the same fact
 * rather than adding one — a checklist is read at a glance or not at all.
 */
const STATUS = {
  [ETaskStatus.pending]: { mark: "○", fg: theme.dim },
  [ETaskStatus.in_progress]: { mark: "⏺", fg: theme.accent },
  [ETaskStatus.completed]: { mark: "✓", fg: theme.dim },
  // Never drawn — `checklistView` filters retired rows out — and present so this map is total.
  [ETaskStatus.deleted]: { mark: "·", fg: theme.dim },
} as const;

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
  const view = checklistView({
    tasks: props.tasks,
    maxRows: props.maxRows ?? CHECKLIST_ROWS,
  });
  if (view.rows.length === 0) return null;

  // Every row is `mark #n text`, so the text gets what is left after the widest number in view.
  const gutter = 4 + String(view.rows[view.rows.length - 1]?.ordinal ?? 1).length;
  const textWidth = Math.max(8, props.width - gutter);

  return (
    <box flexDirection="column" width={props.width}>
      <text fg={theme.dim}>
        tasks · {view.progress}
        {view.hiddenAbove > 0 ? ` · ${view.hiddenAbove} above` : ""}
        {view.hiddenBelow > 0 ? ` · ${view.hiddenBelow} below` : ""}
      </text>
      {view.rows.map((row) => (
        <text key={row.ordinal} fg={STATUS[row.status].fg}>
          <span fg={STATUS[row.status].fg}>{STATUS[row.status].mark}</span> #
          {row.ordinal} {clipTaskText(row.text, textWidth)}
        </text>
      ))}
    </box>
  );
}
