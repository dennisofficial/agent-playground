import React from "react";
import type { ProjectRow } from "../../app/workspace.service.js";
import {
  EAttentionVerb,
  statusCell,
  type Attention,
} from "../../domain/attention.js";
import { fitColumn, fitColumnEnd } from "../../domain/list-columns.js";
import {
  jobLabel,
  shortenHome,
  type ProjectsLayout,
} from "../../domain/projects-list.js";
import { Caret } from "./list-parts.js";
import { courtColour } from "../court.js";
import { glyph, theme } from "../theme.js";

/** Read once: the home directory cannot change under a running terminal. */
const HOME = process.env.HOME ?? "";

/**
 * One project. Exported so `render-smoke.spec.tsx` mounts the real row — it is spans inside a
 * `<text>`, which is where the nested-`<text>` crash lives.
 */
export function ProjectListRow(props: {
  project: ProjectRow;
  attention: Attention;
  selected: boolean;
  layout: ProjectsLayout;
  frame: string;
}): React.ReactNode {
  const { project, attention, layout } = props;
  // Nothing open anywhere inside is not a project-level verb: a project is not a thing you start a
  // phase on. The row falls back to what it has always said in that case.
  const quiet = attention.verb === EAttentionVerb.nothingOpen;

  return (
    <text>
      <Caret on={props.selected} />
      {/* Shape is read state, colour is whose court — the same two channels a job and a thread
          draw, so the top of the app answers the same question the bottom does. */}
      <span fg={courtColour(attention.court)}>
        {attention.unseen ? glyph.unseen : glyph.seen}{" "}
      </span>
      <span>{fitColumn(project.name, layout.name)}</span>
      {/* Clipped from the FRONT: `…/work/atlas` says which folder this is, `/Users/dennis/D…` says
          which machine it is on, and every row would say the same thing. */}
      {layout.path > 0 ? (
        <span fg={theme.dim}>
          {fitColumnEnd(shortenHome({ path: project.path, home: HOME }), layout.path)}
        </span>
      ) : null}
      {/* The verb displaces the job count rather than sitting beside it: when something in there
          needs you, that is the more useful thing to know, and the columns stay put. */}
      {!quiet ? (
        <span fg={courtColour(attention.court)}>
          {statusCell({ attention, frame: props.frame })}
        </span>
      ) : project.exists ? (
        <span fg={theme.dim}>{jobLabel(project.jobCount)}</span>
      ) : (
        /* A missing path stays VISIBLE — a moved repo should be a decision, not a mystery. */
        <span fg={theme.warn}>
          {glyph.warning} path missing
        </span>
      )}
    </text>
  );
}
