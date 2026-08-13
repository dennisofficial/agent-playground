import React from "react";
import { EJobEntry, type JobEntry } from "../../domain/job-groups.js";
import { deletionCost, releaseCost } from "../../domain/jobs-list.js";
import type { JobRow } from "../../store/job.repository.js";
import { ConfirmBar } from "../components/confirm-bar.js";
import type { FooterOverlay } from "../components/list-footer.js";
import type { ComposerControls } from "../hooks/use-composer.js";

/**
 * What the jobs page is waiting for. Exactly one of these owns the keyboard at a time.
 *
 * There is no `create`: naming a job is no longer something this page asks for. `n` leaves for a
 * blank conversation and the first message sent there creates the job and names it.
 */
export type Mode = "browse" | "filter" | "confirm";

/**
 * Which shelf you are looking at. Archiving is a pure HIDE — nothing is closed, no file is touched
 * — so the two lists are the same rows either side of one timestamp, not two kinds of thing.
 */
export type View = "open" | "archived";

/**
 * `12/40` while filtering, `archived` on the shelf — and the shelf wins, because it changes what
 * the whole list IS rather than how much of it you are seeing.
 */
export function headerRight(args: {
  view: View;
  query: string;
  rows: readonly JobRow[];
  all: readonly JobRow[];
}): string {
  if (args.view === "archived") return "archived";
  if (args.query.length > 0) return `${args.rows.length}/${args.all.length}`;
  return "";
}

/**
 * Longest-first, as everywhere: the widest form that fits wins.
 *
 * `← all jobs` is named where there is room for it, because widening is not a guess anyone makes:
 * scoped and unscoped are the same page, so nothing on screen says the wider one exists.
 */
export const HINTS = [
  "↑↓ select · →/⏎ open · / filter · n new · a archive · s shelf · x delete · ← all jobs · p projects · ? keys",
  "↑↓ select · →/⏎ open · / filter · n new · a archive · s shelf · x delete · p projects · ? keys",
  "↑↓ select · ⏎ open · / filter · n new · a archive · s shelf · x delete · p projects",
  "⏎ open · / filter · n new · a archive · s shelf",
];

/**
 * The cursor is on a worktree with no jobs, where three of the keys above mean nothing and two mean
 * something else. Hints follow the CURSOR here rather than the page, because that is the only way a
 * row whose verbs differ from every other row can say so — and this is the one such row.
 */
export const WORKTREE_HINTS = [
  "↑↓ select · ⏎ start a job in this worktree · x remove it · / filter · p projects · ? keys",
  "↑↓ select · ⏎ start a job here · x remove worktree · / filter",
  "⏎ start a job here · x remove",
];

/**
 * The unscoped list has no `n new`, and says so rather than advertising a key that does nothing:
 * a job has to be created somewhere, and standing outside any repository there is no here.
 */
export const UNSCOPED_HINTS = [
  "↑↓ select · →/⏎ open · / filter · a archive · s shelf · x delete · p projects · ? keys",
  "↑↓ select · ⏎ open · / filter · a archive · s shelf · x delete · p projects",
  "⏎ open · / filter · a archive · s shelf",
];

/**
 * Nothing anywhere — no jobs in any project, which is what a first run looks like.
 *
 * Its own line because every verb the list has needs a row to act on, and there are none: `open`,
 * `archive` and `delete` all had nothing to do, and a hint line of dead keys over a blank page is
 * how the widest list came to read as a broken one. Two keys work here, and only those are offered.
 */
export const EMPTY_HINTS = [
  "⏎ pick a project · p projects · ? keys",
  "⏎ pick a project · p projects",
  "⏎ pick a project",
];

/** Restore is the same key as archive — one keypress in, the same keypress back out. */
export const ARCHIVED_HINTS = [
  "↑↓ select · →/⏎ open · a restore · s back to open jobs · x delete · ←/esc back",
  "↑↓ select · ⏎ open · a restore · s open jobs · x delete · esc back",
  "⏎ open · a restore · s open jobs",
];

/** Only filtering borrows the footer's composer now that a job is never named here. */
const OVERLAYS: Partial<Record<Mode, { placeholder: string; caption: string }>> = {
  filter: {
    placeholder: "filter…",
    caption: "↑↓ select · ⏎ open · esc clear",
  },
};

export function overlayFor(args: {
  mode: Mode;
  composer: ComposerControls;
}): FooterOverlay | undefined {
  const form = OVERLAYS[args.mode];
  if (!form) return undefined;
  return {
    ...form,
    state: args.composer.state,
    onCaret: args.composer.setCursor,
  };
}

/**
 * The row past the end of the list, and what `⏎` on it does.
 *
 * Two of them because the page has two shapes and each owes the user a door. Scoped, that door is a
 * new job. Unscoped with nothing anywhere it is the project switcher: a job has to be created
 * SOMEWHERE, so the honest first step is choosing where — and without this row the widest list on a
 * fresh install had no action on it at all, which is the state that reads as a dead end.
 */
export enum EJobAction {
  newJob = "new-job",
  pickProject = "pick-project",
}

export function actionFor(args: {
  view: View;
  /** False on the unscoped list — there is no "here" to create a job in. */
  canCreate: boolean;
  /** No jobs at all, before any filter: the only case that earns the switcher row. */
  empty: boolean;
}): EJobAction | null {
  // The shelf gets neither. A job you create is a job you are working on, by definition, and there
  // is nothing to pick a project FOR while looking at what you have put away.
  if (args.view === "archived") return null;
  if (args.canCreate) return EJobAction.newJob;
  return args.empty ? EJobAction.pickProject : null;
}

export const ACTION_LABELS: Record<EJobAction, string> = {
  [EJobAction.newJob]: "+ new job",
  [EJobAction.pickProject]: "+ pick a project…",
};

/**
 * Which hint line the footer shows. The CURSOR overrides the page: a worktree row's verbs are not the
 * list's verbs, and advertising `a archive` over a row that cannot be archived is worse than silence.
 */
export function hintsFor(args: {
  view: View;
  canCreate: boolean;
  highlighted: JobEntry<JobRow> | undefined;
  action: EJobAction | null;
}): string[] {
  if (args.highlighted?.kind === EJobEntry.worktree) return WORKTREE_HINTS;
  if (args.view === "archived") return ARCHIVED_HINTS;
  // Ahead of both list forms: with no rows anywhere, their verbs are all dead keys.
  if (args.action === EJobAction.pickProject) return EMPTY_HINTS;
  return args.canCreate ? HINTS : UNSCOPED_HINTS;
}

/**
 * One confirm bar, two destructions — and it quotes whichever one `y` is about to perform.
 *
 * Here rather than in the JSX because the pairing IS the safety property: `useJobsKeys` decides what
 * `y` does from the same `highlighted` entry this reads, so a bar naming a job while `y` removes a
 * worktree would require the two to disagree about one value. Neither reads the cursor a second time.
 */
export function confirmFor(
  entry: JobEntry<JobRow> | undefined,
): React.ReactNode {
  if (!entry) return null;
  if (entry.kind === EJobEntry.job) {
    return (
      <ConfirmBar
        question={`delete “${entry.job.title}”?`}
        detail={deletionCost(entry.job)}
      />
    );
  }
  if (entry.kind === EJobEntry.worktree) {
    return (
      <ConfirmBar
        question={`remove worktree “${entry.group.label}”?`}
        detail={releaseCost(entry.group)}
      />
    );
  }
  return null;
}
