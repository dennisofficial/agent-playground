/**
 * The vocabulary a tool block is described in — and a LEAF module, deliberately.
 *
 * `EToolShape` and `EElide` are real enums, so they exist at runtime: a presenter that imported them
 * from the module that imports the presenter registry back is a genuine import cycle, and it fails as
 * `undefined is not an object (evaluating 'EToolShape.gathering')` at the first presenter to evaluate.
 * Keeping the words here, with no imports of its own but the payload type, makes the graph a DAG:
 * `tool-shape` ← `tool-presenters` ← `tool-view`.
 */

import type { ToolResultPayload } from './message.js';

/** One tool call, as much of it as drawing needs. */
export type ToolCall = {
  name: string;
  input: unknown;
  /** Absent while the call is still running. */
  result?: ToolResultPayload;
  cwd: string;
};

/**
 * THE GROUPING RULE, and the only axis it turns on.
 *
 * A `gathering` tool is one whose individual call is not the point — what matters is what the agent
 * LEARNED, and a reader scanning back wants the shape of the search, not eleven headers. Adjacent
 * gathering calls group, ACROSS tools: `Read 6 files, ran 1 command · 515 lines`.
 *
 * A `standalone` tool CHANGED something, or spawned something that did. Each such call is a fact the
 * transcript is the record of, so each gets its own block and each BREAKS the group around it — a
 * `Write` between two searches is exactly where the reader's eye should stop. It is also where the
 * diff lives, and a diff behind a group's expansion is a diff nobody reads.
 *
 * Standalone is the DEFAULT. A tool nobody has classified is one nobody has thought about, and the
 * safe answer for those is a block of its own rather than silent absorption into a group.
 */
export enum EToolShape {
  gathering = 'gathering',
  standalone = 'standalone',
}

/** Which end of a label carries its meaning, and therefore which end survives clipping. */
export enum EElide {
  /** Clip the tail: a pattern or a command says what it is in its first characters. */
  tail = 'tail',
  /** Clip the head: `…/engine/runner/runner.service.ts` still tells you which file. */
  head = 'head',
}

export type ToolRow = {
  label: string;
  elide: EElide;
  /** What came back, in a few characters — `11 l`, `42 matches`. Absent while the call runs. */
  note?: string;
  /** The same measure as a number, so a group's heading can add its rows up. */
  metric?: number;
  ok: boolean;
};

export type ToolView = {
  /** The bold verb a lone call leads with. */
  name: string;
  /** What goes in the parens, already cut to one line's worth. */
  target?: string;
  /**
   * The command, in full, for a tool whose header shows something else instead.
   *
   * Bash is the only one: the header carries the model's `description`, so a fifteen-line pipeline
   * costs one line of transcript — and this is where the command itself goes, so it stays one click
   * away rather than being lost. It is also the part the renderer syntax-highlights.
   */
  command: string[];
  row: ToolRow;
  shape: EToolShape;
};
