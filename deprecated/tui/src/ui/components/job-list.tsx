import React from "react";
import {
  EAttentionVerb,
  statusCell,
  type Attention,
} from "../../domain/attention.js";
import { fitColumn } from "../../domain/list-columns.js";
import { formatWhen, jobAttention, type JobsLayout } from "../../domain/jobs-list.js";
import { EWorkspaceKind, type WorktreeGroup } from "../../domain/worktree.js";
import type { JobRow } from "../../store/job.repository.js";
import { Caret } from "./list-parts.js";
import { courtColour } from "../court.js";
import { glyph, theme } from "../theme.js";

/**
 * One job. Exported so `render-smoke.spec.tsx` mounts the real row rather than a reconstruction —
 * the row is spans inside a `<text>`, which is exactly where the nested-`<text>` crash lives.
 *
 * Nothing about a job's condition is stored: it is the union of its threads' facts, run through the
 * same function a thread row runs. See `domain/attention.ts`.
 */
/**
 * The project a run of jobs belongs to. Only ever drawn unscoped — launched inside a repository the
 * header would name the thing you are already standing in.
 *
 * It carries a condition of its own, rolled up from every thread in the project by the SAME
 * function a job and a thread run. That is what lets you scan a grouped list and see which project
 * wants you without reading any of its rows.
 */
export function JobGroupHeader(props: {
  name: string;
  attention: Attention;
  frame: string;
}): React.ReactNode {
  // Nothing open anywhere inside is not a project-level verb — a project is not a thing you start a
  // phase on — so a quiet group says nothing rather than saying "nothing".
  const quiet = props.attention.verb === EAttentionVerb.nothingOpen;

  return (
    <text>
      <span fg={theme.dim}>{props.name}</span>
      {!quiet ? (
        <span fg={courtColour(props.attention.court)}>
          {"  "}
          {statusCell({ attention: props.attention, frame: props.frame })}
        </span>
      ) : null}
    </text>
  );
}

/**
 * One worktree of the scoped project, above the jobs standing in it.
 *
 * It carries no condition, unlike a project header, and that is not an omission: a project is a set
 * of jobs and can meaningfully want you, but a worktree is a *place*. Rolling its jobs' verbs up here
 * would say "this directory owes you a reply", which is not a thing a directory can do.
 *
 * `no jobs` is the whole reason a group can be empty at all: a LINKED worktree nothing is working in
 * is a branch left behind by a deleted job, a tree checked out by hand, or work some other tool
 * relocated — and before this header existed there was nowhere in Atlas it could appear. The main
 * worktree is exempt, because it is always drawn and its emptiness is not a leak: a project whose
 * every job took a worktree is working exactly as designed, and saying `no jobs` under the heading
 * that names where you are standing would read as a problem instead of a fact.
 */
export function WorktreeGroupHeader(props: {
  group: WorktreeGroup;
  /**
   * Undefined for a heading the cursor cannot reach. It takes the SAME four-cell caret gutter either
   * way — an empty worktree is selectable and its neighbours are not, and a caret that only some rows
   * reserve space for makes the whole column jump as you arrow past them.
   */
  selected?: boolean;
}): React.ReactNode {
  const missing = props.group.kind === EWorkspaceKind.missing;
  const leak = props.group.jobCount === 0 && !props.group.here;
  return (
    <text>
      <Caret on={props.selected === true} />
      <span fg={missing ? theme.warn : theme.dim}>
        {props.group.glyph} {props.group.label}
      </span>
      {leak ? <span fg={theme.dim}>{"  no jobs"}</span> : null}
    </text>
  );
}

export function JobListRow(props: {
  job: JobRow;
  selected: boolean;
  layout: JobsLayout;
  /** The spinner's current frame, for whichever job has a turn in flight somewhere inside it. */
  frame: string;
  runningThreadIds: readonly string[];
  /**
   * Threads of this job holding a pending proposal. The row's whole "waiting on you" signal —
   * `confirm` outranks `working…` inside `attentionFor`, so nothing is decided here.
   */
  proposalThreadIds?: readonly string[];
  /** Another terminal is driving this one. Still openable — it costs one extra keypress. */
  claimed?: boolean;
  /**
   * Whether this job is holding a live service. A boolean rather than a count: the mark is `⚙` and
   * says nothing about how many, so a number here would be a fact the row cannot draw.
   */
  hasService?: boolean;
}): React.ReactNode {
  const { job, layout } = props;
  const attention = jobAttention({
    threads: job.threads,
    runningThreadIds: props.runningThreadIds,
    proposalThreadIds: props.proposalThreadIds ?? [],
    // The render cache `record_pr` writes. It only ever changes the row that has NOTHING open — a
    // shipped job reads `shipped` rather than `start a phase` — and it is not terminal: a later
    // phase makes the same row active again, which is correct. It is out of this machine's hands,
    // not finished with.
    hasPullRequest: job.prNumber !== null,
  });

  return (
    <text>
      <Caret on={props.selected} />
      {/* Shape is read state, colour is whose court. The spinner is NOT here any more: it sits in
          front of the verb, so a job can be working and owe you a keypress at the same time. */}
      <span fg={courtColour(attention.court)}>
        {attention.unseen ? glyph.unseen : glyph.seen}{" "}
      </span>
      <span fg={props.claimed ? theme.dim : undefined}>
        {fitColumn(job.title, layout.title)}
      </span>
      {/* A claimed row says WHERE rather than what it owes. Its verb belongs to the terminal that
          holds it — reporting "reply" for a conversation you cannot see would be an instruction you
          are not in a position to follow. */}
      {layout.status > 0 ? (
        props.claimed ? (
          <span fg={theme.dim}>{fitColumn("elsewhere", layout.status)}</span>
        ) : (
          <span fg={courtColour(attention.court)}>
            {fitColumn(
              statusCell({
                attention,
                frame: props.frame,
                services: props.hasService ? 1 : 0,
              }),
              layout.status,
            )}
          </span>
        )
      ) : null}
      <span fg={theme.dim}>{formatWhen({ date: job.updatedAt })}</span>
    </text>
  );
}
