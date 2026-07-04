import type { JobMessage } from "@/lib/api/job-api";

/**
 * A review-agent LENS (best_practices/correctness/consistency/…) is one parallel self-review pass over a
 * diff. It rides the shared transcript spine on its own `autofix:<autofixId>:<lensId>` lane and tags every
 * durable block with `meta.autofixId` + `meta.lensId` (+ `meta.scope`) — mirrors the backend
 * `autofix.stage.ts` lane contract exactly. `<autofixId>` is the thread id for a per-thread pass, the job id
 * for the PR-tail ("final review") pass — see `meta.scope: 'thread' | 'pr'`.
 *
 * There's no in-conversation card yet (no per-lens OR per-stage anchor node to link a card to beyond this
 * sub-page) — see `docs/handoffs/autofix-review-lane-ui.md` item B for that future work. For now the stage's
 * `autofix_anchor` row and every review block are simply peeled OUT of Main (like a build phase's blocks),
 * leaving only the plain "Reviewing the diff — …" notice line the stage already posts separately.
 */
export const autofixLensLane = (autofixId: string, lensId: string): string =>
  `autofix:${autofixId}:${lensId}`;

/** The auto-fix FIX turn's sub-lane (fix · apply · verify) — byte-identical to the backend `autofixFixLane`
 *  (see `backend/.../thread-registry.ts` / `autofix.stage.ts`). The fix turn tags its blocks `meta.fixTurn`
 *  (NOT `meta.lensId`), so `TranscriptView` filters this lane on `fixTurn` — see `conversation.tsx`. */
export const autofixFixLane = (autofixId: string): string =>
  `autofix:${autofixId}:fix`;

/** The `?node=` sentinel used in place of a thread id to mean "the job-level PR-tail pass". */
export const REVIEW_JOB_SCOPE = "job";

export interface AutofixIndex {
  /** `message.ts` of every block belonging to any review lens or the fix turn (skip these in Main). */
  childKeys: Set<string>;
  /** `message.ts` of every `autofix_anchor` row (skip these in Main too — no card surface exists yet). */
  anchorKeys: Set<string>;
}

/** Peel auto-fix stage blocks out of the main conversation (their content lives in the `rev:` sub-page). */
export function indexAutofixBlocks(messages: JobMessage[]): AutofixIndex {
  const childKeys = new Set<string>();
  const anchorKeys = new Set<string>();
  for (const m of messages) {
    if (m.kind === "autofix_anchor") {
      anchorKeys.add(m.ts);
      continue;
    }
    if (typeof m.meta?.autofixId === "string") childKeys.add(m.ts);
  }
  return { childKeys, anchorKeys };
}
