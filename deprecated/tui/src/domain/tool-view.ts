/**
 * How a tool call is DRAWN — the two questions a caller asks, and the public face of the trio.
 *
 * `tool-summary.ts` is the other half of the pair and runs at a different moment: it turns an engine
 * frame into the summary and detail that get PERSISTED. This runs at draw time, off the call's stored
 * `input`, which is why a tool that wants a different treatment needs no migration — a transcript
 * written last month re-renders under the new rule.
 *
 * The treatments themselves are in `tool-presenters.ts` and the words in `tool-shape.ts`; both are
 * re-exported here so a caller has one import to reach for. Both halves of a tool's treatment still
 * live on ONE presenter, which is the part that matters — two registries disagree the first time
 * somebody edits one.
 */

import { PRESENTERS, READ, STANDALONE } from './tool-presenters.js';
import { failures, total } from './tool-text.js';
import { type ToolCall, type ToolRow, type ToolView, type EToolShape } from './tool-shape.js';

export { EElide, EToolShape } from './tool-shape.js';
export type { ToolCall, ToolRow, ToolView } from './tool-shape.js';
export { displayToolName } from './tool-text.js';

export function presentTool(call: ToolCall): ToolView {
  const presenter = PRESENTERS.get(call.name) ?? STANDALONE;
  return { ...presenter.view(call), row: presenter.row(call), shape: presenter.shape };
}

export function toolShape(name: string): EToolShape {
  return (PRESENTERS.get(name) ?? STANDALONE).shape;
}

/**
 * The line a group leads with.
 *
 * One tool → that tool's own sentence (`Read 6 files · 515 lines`). Several → Claude Code's clause
 * list with a measure on the end (`Read 6 files, ran 1 command · 515 lines`). Both come from here so
 * a group of one tool never reads as a list of one.
 */
export function groupHeading(
  members: readonly { name: string; row: ToolRow }[],
): string {
  const counts = new Map<string, number>();
  for (const member of members) counts.set(member.name, (counts.get(member.name) ?? 0) + 1);

  const rows = members.map((member) => member.row);
  const names = [...counts.keys()];
  const only = names[0];
  if (names.length <= 1) {
    return only === undefined ? '' : (PRESENTERS.get(only) ?? STANDALONE).heading(rows);
  }

  const sentence = names
    .map((name) => (PRESENTERS.get(name) ?? STANDALONE).phrase(counts.get(name) ?? 0))
    .join(', ');
  // Only the READ rows contribute to the line total. A Grep's metric counts MATCHES, and adding the
  // two would print a number that is not a count of anything.
  const read = members
    .filter((member) => PRESENTERS.get(member.name) === READ)
    .map((member) => member.row);
  return (
    sentence.charAt(0).toUpperCase() + sentence.slice(1) + total(read, 'line') + failures(rows)
  );
}
