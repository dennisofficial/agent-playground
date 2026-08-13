/**
 * Adjacent gathering calls, folded into one block.
 *
 * `tool-view.ts` decides WHAT a call says; this decides which calls belong together, which of their
 * rows are on screen, and where the columns fall. The split is the one `tool-diff.ts` / `diff-layout.ts`
 * already draws: content, then arithmetic.
 *
 * Pure and here rather than in the renderer because every rule below is a decision that took a
 * measurement to reach, and each one is a silent failure if it regresses — a group that reshuffles
 * while it streams, a measure column that moves between blocks, an in-flight row hidden behind an
 * elision marker. None of those throws; all of them are visible only to a person looking at a
 * terminal, or to a table test.
 */

import { EMessageType } from '../generated/prisma/enums.js';
import { fitColumn, fitColumnEnd } from './list-columns.js';
import type { Message, ToolCallPayload, ToolResultPayload } from './message.js';
import type { TranscriptItem } from './seam.js';
import {
  EElide,
  EToolShape,
  displayToolName,
  groupHeading,
  presentTool,
  type ToolRow,
  type ToolView,
} from './tool-view.js';

/** Rows a group shows before the rest folds. */
export const GROUP_ROWS = 6;

/**
 * What a line belongs to, and therefore what clicking it toggles.
 *
 * Every line of a thing carries the thing's key, its BODY included. That is the whole interaction
 * rule: to open something you click its summary, to close it you click anywhere in it, and you never
 * have to scroll back to the header you opened it from. It also gives hover its meaning for free —
 * the wash lights every line sharing the key, so what is lit is what is about to collapse.
 */
export enum EHit {
  /** A tool group: show every row, or fold back to `GROUP_ROWS`. */
  group = 'group',
  /** One tool call: open its command and its output. */
  call = 'call',
  /**
   * The rest of one call's OUTPUT. A second level rather than a second gesture: a command can print
   * ten thousand lines, so opening the call shows a head of them and this offers the remainder.
   */
  output = 'output',
  /** A prose message with more to it than fits — thinking, and a seam's attachments. */
  message = 'message',
}

/**
 * Namespaced because a group's id IS its first call's id. Unprefixed, the two would collide in the one
 * open set and opening a group would silently open its first row as well.
 */
export function hitKey(kind: EHit, id: string): string {
  return `${kind}:${id}`;
}

export type GroupMember = {
  payload: ToolCallPayload;
  result?: ToolResultPayload;
  view: ToolView;
};

export type ToolGroup = {
  kind: 'tool_group';
  /**
   * The FIRST call's id. Stable as the group grows during a turn, which a count or an index would
   * not be — and expansion keyed on something that moves is expansion that collapses under the reader.
   */
  id: string;
  /** Every message folded in, so the unseen-anchor can still find itself. */
  messageIds: string[];
  members: GroupMember[];
};

export type GroupedItem = TranscriptItem | ToolGroup;

/**
 * Transcript items → the same items with adjacent gathering calls folded.
 *
 * A `tool_result` message renders nothing of its own — it is drawn under the call it answers — so it
 * must not BREAK a run: `call, result, call, result` is one group of two, which is the shape a
 * sequential agent actually produces. Everything else does break one, including a standalone tool,
 * which is what keeps a diff out of a group.
 */
export function groupTools(args: {
  items: readonly TranscriptItem[];
  results: ReadonlyMap<string, ToolResultPayload>;
  cwd: string;
}): GroupedItem[] {
  const out: GroupedItem[] = [];
  let open: { messageIds: string[]; members: GroupMember[] } | null = null;

  const flush = (): void => {
    if (open === null) return;
    // A group of one is not a group: its heading would restate its only row. It renders as the plain
    // tool block it has always been, which also keeps a lone gathering call's output where it was.
    if (open.members.length > 1) {
      out.push({
        kind: 'tool_group',
        id: open.members[0]?.payload.toolUseId ?? '',
        messageIds: open.messageIds,
        members: open.members,
      });
    } else {
      for (const id of open.messageIds) {
        const message = messagesById.get(id);
        if (message) out.push({ kind: 'message', message });
      }
    }
    open = null;
  };

  const messagesById = new Map<string, Message>();
  for (const item of args.items) {
    if (item.kind === 'message') messagesById.set(item.message.id, item.message);
  }

  for (const item of args.items) {
    if (item.kind !== 'message') {
      flush();
      out.push(item);
      continue;
    }
    const { payload } = item.message;

    if (payload.type === EMessageType.tool_result) {
      if (open !== null) open.messageIds.push(item.message.id);
      else out.push(item);
      continue;
    }

    if (payload.type !== EMessageType.tool_call) {
      flush();
      out.push(item);
      continue;
    }

    const result = args.results.get(payload.toolUseId);
    const view = presentTool({
      name: payload.name,
      input: payload.input,
      cwd: args.cwd,
      ...(result ? { result } : {}),
    });

    if (view.shape === EToolShape.standalone) {
      flush();
      out.push(item);
      continue;
    }

    const member: GroupMember = { payload, ...(result ? { result } : {}), view };
    if (open === null) open = { messageIds: [], members: [] };
    open.messageIds.push(item.message.id);
    open.members.push(member);
  }
  flush();
  return out;
}

export function groupTitle(group: ToolGroup): string {
  return groupHeading(
    group.members.map((member) => ({ name: member.payload.name, row: member.view.row })),
  );
}

/** Left of the heading: the gutter that holds `▶`, `▼` or a spinner, plus its space. */
const GUTTER = 2;

export type GroupHeadline = {
  /** The sentence, already cut to whatever the suffix left it. */
  title: string;
  /** How many calls have no result yet. */
  live: number;
  /** ` · 2 in flight`, or `''`. */
  suffix: string;
};

/**
 * The heading, composed to FIT — and this is a content-shift fix, not cosmetics.
 *
 * A heading grows while a turn runs: `Read 9 files` becomes `Read 10 files`, and ` · 2 in flight`
 * appears and changes width. Left to wrap, crossing the right margin costs the block a whole extra ROW
 * and every line below it jumps — measured, and the most visible jump in a streaming transcript.
 *
 * So the suffix is RESERVED and the sentence gives up characters for it. The suffix is the half that
 * cannot be sacrificed: the counts are re-derivable by eye from the rows, "still working" is not.
 *
 * The counts describe only what has LANDED. A call in flight has no measure yet, and including it
 * would make the total tick up twice per call — once when it starts, once when it finishes.
 */
export function groupHeadline(args: {
  group: ToolGroup;
  running: ReadonlySet<string>;
  width: number;
}): GroupHeadline {
  const live = args.group.members.filter((member) =>
    args.running.has(member.payload.toolUseId),
  ).length;
  const suffix = live > 0 ? ` · ${live} in flight` : '';
  const landed = args.group.members.filter(
    (member) => !args.running.has(member.payload.toolUseId),
  );
  const title = groupHeading(
    landed.map((member) => ({ name: member.payload.name, row: member.view.row })),
  );

  const budget = args.width - GUTTER - suffix.length;
  if (budget <= 0) return { title: '', live, suffix };
  return {
    title: title.length <= budget ? title : `${title.slice(0, Math.max(0, budget - 1))}…`,
    live,
    suffix,
  };
}

/**
 * Which rows a group SHOWS: the TAIL, always.
 *
 * Open shows everything. Otherwise the last `GROUP_ROWS`, with the elision marker above them.
 *
 * ## Why the tail, and not the head
 *
 * The obvious rule was head-when-settled, tail-when-streaming: a finished group reads from its start,
 * a running one has to keep its in-flight row on screen. Measured, that rule costs a JUMP — at the
 * moment the last call lands the window flips, the elision marker moves from above the rows to below
 * them, and the whole block shifts by a row. It is the most jarring frame in a streaming turn, and it
 * lands exactly when the reader has started reading.
 *
 * The tail is also the better answer on its own merits. It is the half of the group the reader was
 * WATCHING while it streamed, so nothing moves when the turn ends and attention stays where it was.
 * And nothing is lost by dropping the head, because the heading is the group's summary — `Read 52
 * files, ran 52 commands, searched 7 patterns` already says what the block contains, which leaves the
 * rows free to say where it got to.
 *
 * Reveal is a SLICE, never a filter, so it is append-only within a case. An earlier version dealt rows
 * round-robin across the tools present so a collapsed 104-call block would not be all Reads; that
 * re-selected the set as the group grew, and rows already on screen were swapped out under the reader.
 */
export function visibleRows(args: {
  members: readonly GroupMember[];
  open: boolean;
}): { shown: GroupMember[]; earlier: number } {
  const members = [...args.members];
  if (args.open || members.length <= GROUP_ROWS) return { shown: members, earlier: 0 };
  return { shown: members.slice(-GROUP_ROWS), earlier: members.length - GROUP_ROWS };
}
