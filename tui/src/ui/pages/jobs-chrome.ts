import type { JobRow } from "../../store/job.repository.js";
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

/** Longest-first, as everywhere: the widest form that fits wins. */
export const HINTS = [
  "↑↓ select · →/⏎ open · / filter · n new · a archive · s shelf · x delete · p projects · ? keys",
  "↑↓ select · ⏎ open · / filter · n new · a archive · s shelf · x delete · p projects",
  "⏎ open · / filter · n new · a archive · s shelf",
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
