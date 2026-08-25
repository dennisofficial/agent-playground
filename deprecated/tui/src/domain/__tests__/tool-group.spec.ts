import { describe, expect, it } from 'bun:test';
import { EMessageType } from '../../generated/prisma/enums.js';
import type { Message, ToolCallPayload, ToolResultPayload } from '../message.js';
import type { TranscriptItem } from '../seam.js';
import { groupLayout, rowLabel, rowNote, rowVerb } from '../group-layout.js';
import {
  EHit,
  GROUP_ROWS,
  groupHeadline,
  groupTitle,
  groupTools,
  hitKey,
  visibleRows,
  type GroupMember,
  type ToolGroup,
} from '../tool-group.js';
import { presentTool } from '../tool-view.js';

/**
 * The grouping boundary, the visible window, and the columns.
 *
 * Every assertion here stands in for a jump or a lie a person could only catch by staring at a
 * terminal: a group that swallows a diff, a window that reshuffles as it streams, an in-flight row
 * hidden behind an elision marker, a measure column that moves between blocks.
 */

const CWD = '/repo';
let ordinal = 0;

function message(payload: Message['payload'], id = `m-${(ordinal += 1)}`): Message {
  return {
    id,
    threadId: 't',
    sessionId: 's',
    ordinal,
    payload,
    createdAt: new Date(0),
  };
}

function toolCall(args: {
  id: string;
  name: string;
  input?: unknown;
}): Message {
  return message({
    type: EMessageType.tool_call,
    toolUseId: args.id,
    name: args.name,
    input: args.input ?? {},
  });
}

function toolResult(args: { id: string; ok?: boolean; detail?: string[] }): Message {
  return message({
    type: EMessageType.tool_result,
    toolUseId: args.id,
    ok: args.ok ?? true,
    summary: 'done',
    detail: args.detail ?? [],
  });
}

function items(...messages: Message[]): TranscriptItem[] {
  return messages.map((m) => ({ kind: 'message', message: m }));
}

function resultsOf(...messages: Message[]): Map<string, ToolResultPayload> {
  const map = new Map<string, ToolResultPayload>();
  for (const m of messages) {
    if (m.payload.type === EMessageType.tool_result) map.set(m.payload.toolUseId, m.payload);
  }
  return map;
}

function group(args: { names: string[]; running?: string[] }): ToolGroup {
  const members: GroupMember[] = args.names.map((name, index) => {
    const id = `c-${index}`;
    const running = args.running?.includes(id) ?? false;
    const result: ToolResultPayload = {
      type: EMessageType.tool_result,
      toolUseId: id,
      ok: true,
      summary: 'done',
      detail: ['a'],
    };
    const payload: ToolCallPayload = {
      type: EMessageType.tool_call,
      toolUseId: id,
      name,
      input: name === 'Bash' ? { command: 'ls', description: `Do thing ${index}` } : { file_path: `${CWD}/f${index}.ts` },
    };
    return {
      payload,
      ...(running ? {} : { result }),
      view: presentTool({
        name,
        input: payload.input,
        cwd: CWD,
        ...(running ? {} : { result }),
      }),
    };
  });
  return { kind: 'tool_group', id: 'c-0', messageIds: members.map((m) => m.payload.toolUseId), members };
}

describe('groupTools', () => {
  it('folds adjacent gathering calls across tools, results and all', () => {
    // `call, result, call, result` is one group of two — a result renders under its call, so it must
    // not break the run.
    const messages = [
      toolCall({ id: 'a', name: 'Read', input: { file_path: `${CWD}/a.ts` } }),
      toolResult({ id: 'a', detail: ['1', '2'] }),
      toolCall({ id: 'b', name: 'Bash', input: { command: 'ls', description: 'List' } }),
      toolResult({ id: 'b', detail: ['x'] }),
    ];
    const out = groupTools({ items: items(...messages), results: resultsOf(...messages), cwd: CWD });

    expect(out).toHaveLength(1);
    const only = out[0];
    if (only?.kind !== 'tool_group') throw new Error('expected a group');
    expect(only.members).toHaveLength(2);
    // Both call ids AND both result ids, so an unseen-anchor hung on any of them still resolves.
    expect(only.messageIds).toHaveLength(4);
    expect(only.id).toBe(messages[0]?.id === undefined ? '' : 'a');
  });

  it('never folds a standalone call, and breaks the group either side of it', () => {
    // This is the property the whole design turns on: an edit's diff can never be inside a fold.
    const messages = [
      toolCall({ id: 'a', name: 'Read' }),
      toolCall({ id: 'b', name: 'Read' }),
      toolCall({ id: 'w', name: 'Write', input: { file_path: `${CWD}/w.ts` } }),
      toolCall({ id: 'c', name: 'Read' }),
      toolCall({ id: 'd', name: 'Read' }),
    ];
    const out = groupTools({ items: items(...messages), results: new Map(), cwd: CWD });

    expect(out.map((item) => item.kind)).toEqual([
      'tool_group',
      'message',
      'tool_group',
    ]);
  });

  it('leaves a lone gathering call as the plain block it has always been', () => {
    // A group of one would restate its only row in its heading.
    const messages = [
      toolCall({ id: 'a', name: 'Read' }),
      toolResult({ id: 'a' }),
      message({ type: EMessageType.assistant, text: 'prose' }),
      toolCall({ id: 'b', name: 'Read' }),
    ];
    const out = groupTools({ items: items(...messages), results: new Map(), cwd: CWD });
    expect(out.map((item) => item.kind)).toEqual(['message', 'message', 'message', 'message']);
  });

  it('breaks a group on prose, and on a seam', () => {
    const messages = [
      toolCall({ id: 'a', name: 'Read' }),
      toolCall({ id: 'b', name: 'Read' }),
      message({ type: EMessageType.assistant, text: 'so far so good' }),
      toolCall({ id: 'c', name: 'Read' }),
      toolCall({ id: 'd', name: 'Read' }),
    ];
    const withSeam: TranscriptItem[] = [
      ...items(...messages),
      { kind: 'seam', sessionId: 's2', ordinal: 2, endReason: null },
      ...items(toolCall({ id: 'e', name: 'Read' }), toolCall({ id: 'f', name: 'Read' })),
    ];
    const out = groupTools({ items: withSeam, results: new Map(), cwd: CWD });
    expect(out.map((item) => item.kind)).toEqual([
      'tool_group',
      'message',
      'tool_group',
      'seam',
      'tool_group',
    ]);
  });

  it('passes an orphan result through rather than dropping it', () => {
    const orphan = toolResult({ id: 'nobody' });
    const out = groupTools({ items: items(orphan), results: new Map(), cwd: CWD });
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe('message');
  });
});

describe('visibleRows', () => {
  it('shows everything when the group is open', () => {
    const g = group({ names: Array.from({ length: 20 }, () => 'Read') });
    const view = visibleRows({ members: g.members, open: true });
    expect(view.shown).toHaveLength(20);
    expect(view.earlier).toBe(0);
  });

  it('shows the TAIL, so the in-flight row is the block’s last line', () => {
    const g = group({ names: Array.from({ length: 20 }, () => 'Read'), running: ['c-19'] });
    const view = visibleRows({ members: g.members, open: false });
    expect(view.shown).toHaveLength(GROUP_ROWS);
    expect(view.shown.at(-1)).toBe(g.members.at(-1));
    expect(view.earlier).toBe(20 - GROUP_ROWS);
  });

  it('shows the tail whether or not anything is running — no settle flip', () => {
    // Head-when-settled / tail-when-streaming cost a jump at the exact moment the last call landed:
    // the window flipped and the elision marker moved from above the rows to below them. One rule
    // instead, so the rows the reader was watching are the rows that stay.
    const g = group({ names: Array.from({ length: 20 }, () => 'Read') });
    const streaming = visibleRows({ members: g.members, open: false });
    const settled = visibleRows({ members: g.members, open: false });
    expect(settled.shown.map((m) => m.payload.toolUseId)).toEqual(
      streaming.shown.map((m) => m.payload.toolUseId),
    );
    expect(settled.earlier).toBe(streaming.earlier);
  });

  it('reveals APPEND-ONLY as a group fills in: the live row stays the final line', () => {
    // The regression this guards: a selection that re-chose its rows as the group grew swapped out
    // rows already on screen, so the block appeared to reshuffle on every arriving call.
    const names = Array.from({ length: 20 }, () => 'Read');
    let previousTail: string | undefined;
    for (let filled = 10; filled <= 20; filled += 1) {
      const g = group({ names: names.slice(0, filled), running: [`c-${filled - 1}`] });
      const view = visibleRows({ members: g.members, open: false });
      const tail = view.shown.at(-1)?.payload.toolUseId;
      expect(tail).toBe(`c-${filled - 1}`);
      expect(tail).not.toBe(previousTail);
      previousTail = tail;
      // And the block's ROW COUNT is constant, which is what stops it pushing the transcript around.
      expect(view.shown.length).toBe(GROUP_ROWS);
    }
  });

  it('shows a short group whole, with no elision at all', () => {
    const g = group({ names: ['Read', 'Bash'] });
    const view = visibleRows({ members: g.members, open: false });
    expect(view.shown).toHaveLength(2);
    expect(view.earlier).toBe(0);
  });
});

describe('groupLayout', () => {
  it('pins the measure to the right margin so the column does not move between blocks', () => {
    const g = group({ names: ['Read', 'Read'] });
    const layout = groupLayout({ members: g.members, width: 100 });
    const row = g.members[0]!.view.row;
    // indent + label + gap + note fills the width exactly, which is what puts every count in the
    // transcript in the same column.
    expect(5 + rowLabel(row, layout).length + rowNote(row, layout).length).toBe(100);
  });

  it('gives a MIXED group a tool-name column and a single-tool group none', () => {
    const mixed = group({ names: ['Read', 'Bash'] });
    expect(groupLayout({ members: mixed.members, width: 100 }).verb).toBe(4);
    // The heading already said the word; a column of the same four characters is spent width.
    const same = group({ names: ['Read', 'Read'] });
    expect(groupLayout({ members: same.members, width: 100 }).verb).toBe(0);
    expect(rowVerb(same.members[0]!, groupLayout({ members: same.members, width: 100 }))).toBe('');
  });

  it('keeps the row exactly the content width once the verb column is in play', () => {
    const g = group({ names: ['Read', 'Bash', 'Read'] });
    const layout = groupLayout({ members: g.members, width: 80 });
    for (const member of g.members) {
      const width =
        5 +
        rowVerb(member, layout).length +
        rowLabel(member.view.row, layout).length +
        rowNote(member.view.row, layout).length;
      expect(width).toBe(80);
    }
  });

  it('keeps a label readable on a narrow terminal rather than collapsing it to nothing', () => {
    const g = group({ names: ['Read', 'Bash'] });
    expect(groupLayout({ members: g.members, width: 20 }).label).toBeGreaterThanOrEqual(16);
  });

  it('clips a path from the FRONT and a description from the BACK', () => {
    const layout = { verb: 0, label: 14, note: 0 };
    // A path means its END — `…/domain/tool-view.ts` still names the file. A description means its
    // START, so it keeps its opening words. Same column, opposite ends.
    const path = presentTool({
      name: 'Read',
      input: { file_path: `${CWD}/src/domain/tool-view.ts` },
      cwd: CWD,
    }).row;
    const command = presentTool({
      name: 'Bash',
      input: { command: 'ls', description: 'List every source file under src' },
      cwd: CWD,
    }).row;

    expect(rowLabel(path, layout)).toBe('…tool-view.ts ');
    expect(rowLabel(command, layout)).toBe('List every s… ');
  });
});

describe('groupTitle', () => {
  it('is the group’s sentence, which is what makes the rows only need to be the head of the list', () => {
    expect(groupTitle(group({ names: ['Read', 'Read', 'Bash'] }))).toBe(
      'Read 2 files, ran 1 command · 2 lines',
    );
  });
});

describe('hitKey', () => {
  it('namespaces a group away from its own first call', () => {
    // A group's id IS its first call's id. Unprefixed they collide in the one open set, and opening a
    // group would silently open its first row too.
    expect(hitKey(EHit.group, 'c-0')).not.toBe(hitKey(EHit.call, 'c-0'));
  });
});

/**
 * CONTENT SHIFT.
 *
 * A streaming transcript re-renders many times a second, and every one of these is a jump the reader
 * sees: a heading that wraps costs the block a row, a column measured from the visible rows moves
 * sideways as the window scrolls, a spinner that grows from `4s` to `12s` widens the measure column
 * and slides every label with it. None of them throws. All of them are assertions.
 */
describe('content shift', () => {
  it('never lets the heading exceed its width, so it cannot wrap and cost a row', () => {
    const g = group({ names: Array.from({ length: 40 }, (_, i) => (i % 2 ? 'Bash' : 'Read')) });
    for (const width of [40, 60, 80, 100, 140]) {
      for (const running of [new Set<string>(), new Set(['c-38', 'c-39'])]) {
        const headline = groupHeadline({ group: g, running, width });
        // Gutter + title + suffix has to FIT. One character over and the row count changes.
        expect(2 + headline.title.length + headline.suffix.length).toBeLessThanOrEqual(width);
      }
    }
  });

  it('keeps the in-flight suffix and sacrifices the sentence for it', () => {
    // The counts are re-derivable by eye from the rows below. "Still working" is not.
    const g = group({ names: Array.from({ length: 40 }, (_, i) => (i % 2 ? 'Bash' : 'Read')) });
    const headline = groupHeadline({ group: g, running: new Set(['c-38', 'c-39']), width: 44 });
    expect(headline.suffix).toBe(' · 2 in flight');
    expect(headline.live).toBe(2);
    expect(headline.title.endsWith('…')).toBe(true);
  });

  it('counts only what has LANDED, so a total does not tick twice per call', () => {
    const g = group({ names: ['Read', 'Read', 'Read'] });
    const settled = groupHeadline({ group: g, running: new Set(), width: 100 });
    const streaming = groupHeadline({ group: g, running: new Set(['c-2']), width: 100 });
    expect(settled.title).toBe('Read 3 files · 3 lines');
    expect(streaming.title).toBe('Read 2 files · 2 lines');
  });

  it('measures the columns over EVERY member, not the visible window', () => {
    // The bug: a mixed group whose tail window happened to hold one tool dropped the verb column, and
    // every label in the block jumped six columns left as it streamed.
    // Mixed group whose visible TAIL holds a single tool — exactly the shape that dropped the column.
    const g = group({ names: ['Bash', 'Bash', ...Array.from({ length: 10 }, () => 'Read')] });
    const all = groupLayout({ members: g.members, width: 100 });
    const tail = visibleRows({ members: g.members, open: false });

    expect(new Set(tail.shown.map((m) => m.payload.name))).toEqual(new Set(['Read']));
    // Measured over the group, the verb column survives a window that cannot see the Bash calls.
    expect(all.verb).toBe(4);
    expect(groupLayout({ members: tail.shown, width: 100 }).verb).toBe(0);
  });

  it('reserves the spinner’s width so the measure column does not breathe every second', () => {
    // `⠋ 4s` → `⠋ 12s` → `⠋ 1m 5s` would widen the column and slide every label, twice a second.
    const g = group({ names: ['Read', 'Read'], running: ['c-1'] });
    const streaming = groupLayout({ members: g.members, width: 100, running: new Set(['c-1']) });
    expect(streaming.note).toBeGreaterThanOrEqual('⠋ 59m 59s'.length);
  });

  it('holds the row geometry constant across every window of one streaming group', () => {
    // The whole point, asserted end to end: as a group fills in, no row changes width.
    const names = Array.from({ length: 30 }, (_, i) => (i % 3 === 0 ? 'Bash' : 'Read'));
    const widths = new Set<number>();
    for (let filled = 8; filled <= 30; filled += 1) {
      const g = group({ names: names.slice(0, filled), running: [`c-${filled - 1}`] });
      const running = new Set([`c-${filled - 1}`]);
      const layout = groupLayout({ members: g.members, width: 100, running });
      for (const member of visibleRows({ members: g.members, open: false }).shown) {
        widths.add(
          5 +
            rowVerb(member, layout).length +
            rowLabel(member.view.row, layout).length +
            rowNote(member.view.row, layout).length,
        );
      }
    }
    expect([...widths]).toEqual([100]);
  });
});

describe('EHit.output', () => {
  it('is a distinct level from the call it belongs to', () => {
    // Opening a call shows a head of its output; opening the output shows the rest. Two levels, one
    // gesture — so they cannot share a key or the first click would do both.
    expect(hitKey(EHit.output, 'c-0')).not.toBe(hitKey(EHit.call, 'c-0'));
    expect(hitKey(EHit.output, 'c-0')).not.toBe(hitKey(EHit.group, 'c-0'));
  });
});
