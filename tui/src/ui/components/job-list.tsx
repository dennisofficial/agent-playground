import React from "react";
import { statusCell } from "../../domain/attention.js";
import { fitColumn } from "../../domain/list-columns.js";
import { formatWhen, jobAttention, type JobsLayout } from "../../domain/jobs-list.js";
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
export function JobListRow(props: {
  job: JobRow;
  selected: boolean;
  layout: JobsLayout;
  /** The spinner's current frame, for whichever job has a turn in flight somewhere inside it. */
  frame: string;
  runningThreadIds: readonly string[];
}): React.ReactNode {
  const { job, layout } = props;
  const attention = jobAttention({
    threads: job.threads,
    runningThreadIds: props.runningThreadIds,
  });

  return (
    <text>
      <Caret on={props.selected} />
      {/* Shape is read state, colour is whose court. The spinner is NOT here any more: it sits in
          front of the verb, so a job can be working and owe you a keypress at the same time. */}
      <span fg={courtColour(attention.court)}>
        {attention.unseen ? glyph.unseen : glyph.seen}{" "}
      </span>
      <span>{fitColumn(job.title, layout.title)}</span>
      {layout.status > 0 ? (
        <span fg={courtColour(attention.court)}>
          {fitColumn(statusCell({ attention, frame: props.frame }), layout.status)}
        </span>
      ) : null}
      <span fg={theme.dim}>{formatWhen({ date: job.updatedAt })}</span>
    </text>
  );
}
