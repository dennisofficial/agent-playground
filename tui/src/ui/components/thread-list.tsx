import React from "react";
import { EAttentionCourt, statusCell } from "../../domain/attention.js";
import { fitColumn } from "../../domain/list-columns.js";
import type {
  PhaseGroupView,
  ThreadListRow,
  ThreadsLayout,
} from "../../domain/threads-list.js";
import { Caret } from "./list-parts.js";
import { courtColour } from "../court.js";
import { glyph, theme } from "../theme.js";

/**
 * A phase and its threads. Phases are HEADERS, not nodes: the cursor walks threads and steps over
 * the captions, so a group draws its label and then indexes its rows into the one flat order the
 * page keeps. Exported so `render-smoke.spec.tsx` mounts the real row rather than a reconstruction —
 * this row is spans inside a `<text>`, which is exactly where the nested-`<text>` crash lives.
 */
export function PhaseGroup(props: {
  group: PhaseGroupView;
  cursor: number;
  layout: ThreadsLayout;
  /** The spinner's current frame, for whichever row has a turn in flight. */
  frame: string;
}): React.ReactNode {
  return (
    <box flexDirection="column">
      <text fg={theme.dim}>{`  ${props.group.label}`}</text>
      {props.group.threads.map((thread) => (
        <ThreadRow
          key={thread.id}
          thread={thread}
          selected={thread.index === props.cursor}
          layout={props.layout}
          frame={props.frame}
        />
      ))}
    </box>
  );
}

function ThreadRow(props: {
  thread: ThreadListRow;
  selected: boolean;
  layout: ThreadsLayout;
  frame: string;
}): React.ReactNode {
  const { thread, layout } = props;
  const { attention } = thread;
  // History goes dim WHOLESALE rather than earning a badge. A finished leg is most of a mature
  // job's list, and weight — not a word at the end of the line — is what lets the eye skip it and
  // land on the one or two rows still live. `none` is exactly "nobody's court", which is history.
  const history = attention.court === EAttentionCourt.none;

  return (
    <text>
      <Caret on={props.selected} />
      {/* Two channels in one cell: the SHAPE is read state, the COLOUR is whose court it is in.
          Never collapse them — an unseen proposal and an unseen question are different rows. */}
      <span fg={courtColour(attention.court)}>
        {attention.unseen ? glyph.unseen : glyph.seen}{" "}
      </span>
      <span fg={nameColour({ active: thread.active, history })}>
        {fitColumn(thread.label, layout.role)}
      </span>
      {layout.engine > 0 ? (
        <span fg={theme.dim}>{fitColumn(thread.engine, layout.engine)}</span>
      ) : null}
      {layout.messages > 0 ? (
        <span fg={theme.dim}>{fitColumn(thread.messages, layout.messages)}</span>
      ) : null}
      {layout.sessions > 0 ? (
        <span fg={theme.dim}>{fitColumn(thread.sessions, layout.sessions)}</span>
      ) : null}
      {layout.state > 0 ? (
        <span fg={courtColour(attention.court)}>
          {fitColumn(statusCell({ attention, frame: props.frame }), layout.state)}
        </span>
      ) : null}
    </text>
  );
}

/**
 * Where `ACTIVE` went. It is a pointer — where a `⏎` on the job lands — not something you owe, so
 * it stopped competing for the status column when that column became the verb. Weight on the name
 * says the same thing in no columns at all.
 */
function nameColour(args: { active: boolean; history: boolean }): string {
  if (args.history) return theme.dim;
  return args.active ? theme.accent : theme.hover;
}
