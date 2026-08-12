import React from "react";
import {
  fitHeader,
  type HeaderFacts,
} from "../../domain/conversation-header.js";
import { PageHeader } from "./page-header.js";

/**
 * The conversation's one line, and the only thing identifying a tile in a grid of them.
 *
 * All of the decisions are in `domain/conversation-header.ts`, where they can be asserted at forty,
 * sixty and a hundred and twenty columns without a terminal. This is the wiring left over: measure,
 * and hand the winning form to the shared header.
 */
export function Breadcrumb(props: {
  facts: HeaderFacts;
  width: number;
}): React.ReactNode {
  // 2 for the `‹ ` back affordance, which every form has to leave room for.
  const form = fitHeader({ facts: props.facts, width: props.width, gutter: 2 });

  // A single-segment trail rather than a project › job › role path. The trail was what put the
  // project first on the line and therefore made it the first thing dropped — exactly backwards
  // once one tile is one job.
  return (
    <PageHeader
      trail={[form.left]}
      right={form.right}
      width={props.width}
      canBack
    />
  );
}
