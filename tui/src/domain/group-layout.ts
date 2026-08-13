/**
 * Where a tool group's columns fall, as arithmetic rather than as JSX.
 *
 * `tool-group.ts` decides WHICH calls belong together and which of their rows are on screen; this
 * decides where the three columns sit. The same split `tool-diff.ts` / `diff-layout.ts` already draws,
 * and for the same reason: the measurements are taken across the whole block rather than per row, so
 * they have to happen once above the rows and be checkable without a terminal.
 */

import { fitColumn, fitColumnEnd } from './list-columns.js';
import type { GroupMember } from './tool-group.js';
import { displayToolName } from './tool-text.js';
import { EElide, type ToolRow } from './tool-shape.js';

/** Left of a group's rows: the same five columns every other line of tool detail is indented by. */
export const GROUP_INDENT = 5;
/** One blank column between a row's label and its measure, and between the verb and the label. */
export const GROUP_GAP = 2;
/** Below this a label says nothing, so the block stops trying to hold a measure column. */
const MIN_LABEL = 16;

/**
 * Columns a running row's measure reserves — `⠋ 59m 59s` is the widest it gets.
 *
 * Reserved rather than measured, because the measure column is sized once for the whole block: a
 * spinner that grew from `⠋ 4s` to `⠋ 12s` would widen the column and slide every LABEL in the group
 * sideways, twice a second, for the whole turn.
 */
const RUNNING_NOTE = 9;

export type GroupLayout = {
  /** Width of the tool-name column, or 0 when the group holds one tool. */
  verb: number;
  label: number;
  note: number;
};

/**
 * Where a group's three columns fall.
 *
 * **The measure is pinned to the RIGHT MARGIN**, not sized to the longest label. When a group held one
 * tool, sizing to the longest label closed a wide gap and read better; a group that folds across tools
 * holds paths AND command descriptions AND patterns, so the longest label lands somewhere different in
 * every block — and a measure column that moves between blocks is not a column. Pinned, every count in
 * the transcript lines up and the eye reads down them.
 *
 * **The verb column exists only for a MIXED group.** Folding across kinds put `Run typecheck and test
 * suite` directly above `tui/src/domain/phase-spec.ts` with nothing saying which was a command and
 * which was a file. Where every row is the same tool the heading has already said the word, and a
 * column of the same four characters is spent width.
 */
export function groupLayout(args: {
  /**
   * EVERY member, not the visible slice. Measuring the slice made the columns move as a streaming
   * group scrolled its window and as rows were revealed — the widest label in view changes, so the
   * label column changes, so every row shifts sideways. Measuring the whole group makes the block's
   * geometry a property of the group rather than of what happens to be on screen.
   */
  members: readonly GroupMember[];
  width: number;
  /** Calls with no result yet, so their measure can reserve its width up front. */
  running?: ReadonlySet<string>;
}): GroupLayout {
  const names = new Set(args.members.map((member) => displayToolName(member.payload.name)));
  const verb = names.size > 1 ? Math.max(...[...names].map((name) => name.length)) : 0;
  const anyRunning = args.members.some((member) =>
    args.running?.has(member.payload.toolUseId),
  );
  const note = args.members.reduce(
    (widest, member) => Math.max(widest, member.view.row.note?.length ?? 0),
    anyRunning ? RUNNING_NOTE : 0,
  );
  const label = Math.max(
    MIN_LABEL,
    args.width - GROUP_INDENT - (verb > 0 ? verb + GROUP_GAP : 0) - GROUP_GAP - note,
  );
  return { verb, label, note };
}

/**
 * A row's label, padded to exactly its column and clipped from whichever end does NOT carry the
 * meaning. A row is a table cell, so it clips — see `wrapWords` for the prose half of that rule.
 */
export function rowLabel(row: ToolRow, layout: GroupLayout): string {
  return row.elide === EElide.head
    ? fitColumnEnd(row.label, layout.label)
    : fitColumn(row.label, layout.label);
}

/** A row's measure, right-aligned into its column with the gap in front of it. */
export function rowNote(row: ToolRow, layout: GroupLayout): string {
  return ' '.repeat(GROUP_GAP) + (row.note ?? '').padStart(layout.note);
}

/** The dim tool-name cell, or `''` for a group that does not have the column. */
export function rowVerb(member: GroupMember, layout: GroupLayout): string {
  if (layout.verb === 0) return '';
  return displayToolName(member.payload.name).padEnd(layout.verb) + ' '.repeat(GROUP_GAP);
}
