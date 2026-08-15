import React from "react";
import type { Attention } from "../../domain/attention.js";
import { EJobEntry, type JobEntry } from "../../domain/job-groups.js";
import type { JobsLayout } from "../../domain/jobs-list.js";
import type { JobRow } from "../../store/job.repository.js";
import { JobGroupHeader, JobListRow, WorktreeGroupHeader } from "./job-list.js";

/**
 * The body of the jobs list: whatever `useJobEntries` produced, drawn.
 *
 * One component for both grouping axes because the entry union is one union — the page above has a
 * single cursor and a single index rule, and this is the only place that has to know a header from a
 * row. It lives apart from the page for the ordinary reason: the page was at its line budget.
 */
export function JobEntries(props: {
  entries: readonly JobEntry<JobRow>[];
  cursor: number;
  layout: JobsLayout;
  frame: string;
  runningThreadIds: readonly string[];
  proposals: Map<string, string[]>;
  isClaimed: (job: JobRow) => boolean;
  projectAttention: (projectId: string) => Attention;
  /** The jobs holding a live service, by id — a set because the row only asks whether it is in it. */
  serviceJobIds: ReadonlySet<string>;
}): React.ReactNode {
  return (
    <>
      {props.entries.map((entry, position) => {
        if (entry.kind === EJobEntry.header) {
          return (
            <Group key={`h:${entry.projectId}`} first={position === 0}>
              <JobGroupHeader
                name={entry.projectName}
                attention={props.projectAttention(entry.projectId)}
                frame={props.frame}
              />
            </Group>
          );
        }

        if (entry.kind === EJobEntry.worktree) {
          return (
            <Group key={`w:${entry.group.path}`} first={position === 0}>
              <WorktreeGroupHeader
                group={entry.group}
                selected={entry.index !== null && entry.index === props.cursor}
              />
            </Group>
          );
        }

        return (
          <JobListRow
            key={entry.job.id}
            job={entry.job}
            selected={entry.index === props.cursor}
            layout={props.layout}
            frame={props.frame}
            runningThreadIds={props.runningThreadIds}
            proposalThreadIds={props.proposals.get(entry.job.id) ?? []}
            claimed={props.isClaimed(entry.job)}
            hasService={props.serviceJobIds.has(entry.job.id)}
          />
        );
      })}
    </>
  );
}

/**
 * Air above every group but the first — the rule that separates them is whitespace, because a list
 * this dense cannot afford a second kind of line.
 */
function Group(props: {
  first: boolean;
  children: React.ReactNode;
}): React.ReactNode {
  return (
    <box flexDirection="column">
      {props.first ? null : <text> </text>}
      {props.children}
    </box>
  );
}
