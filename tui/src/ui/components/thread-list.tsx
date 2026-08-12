import React from "react";
import { fitColumn } from "../../domain/list-columns.js";
import {
  EThreadState,
  type PhaseGroupView,
  type ThreadListRow,
  type ThreadsLayout,
} from "../../domain/threads-list.js";
import { Caret } from "./list-parts.js";
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
  const closed = thread.state === EThreadState.closed;
  // Closed rows go dim WHOLESALE rather than earning a badge. A finished leg is most of a mature
  // job's list, and weight — not a word at the end of the line — is what lets the eye skip it and
  // land on the one or two rows still live.
  const bodyColour = closed ? theme.dim : theme.hover;

  return (
    <text>
      <Caret on={props.selected} />
      <span fg={dotColour(thread.state)}>
        {dot({ state: thread.state, frame: props.frame })}{" "}
      </span>
      <span fg={bodyColour}>{fitColumn(thread.label, layout.role)}</span>
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
        <span fg={stateColour(thread.state)}>
          {fitColumn(thread.stateLabel, layout.state)}
        </span>
      ) : null}
    </text>
  );
}

/**
 * The dot carries the OPEN/CLOSED axis and nothing else — filled while a thread can still be typed
 * into, hollow once it is history. The spinner replaces it on a working row for the same reason it
 * does on the jobs list: working is a state of the thread, not a badge on it.
 */
function dot(args: { state: EThreadState; frame: string }): string {
  if (args.state === EThreadState.working) return args.frame;
  return args.state === EThreadState.closed ? glyph.available : glyph.active;
}

function dotColour(state: EThreadState): string {
  if (state === EThreadState.working || state === EThreadState.active)
    return theme.accent;
  return theme.dim;
}

function stateColour(state: EThreadState): string {
  return state === EThreadState.working || state === EThreadState.active
    ? theme.accent
    : theme.dim;
}
