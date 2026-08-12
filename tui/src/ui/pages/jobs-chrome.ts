import type { JobRow } from "../../store/job.repository.js";
import type { FooterOverlay } from "../components/list-footer.js";
import type { ComposerControls } from "../hooks/use-composer.js";

/** What the jobs page is waiting for. Exactly one of these owns the keyboard at a time. */
export type Mode = "browse" | "filter" | "create" | "confirm";

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
  "↑↓ select · →/⏎ open · / filter · n new · a archive · s shelf · x delete · ? keys · ←/esc back",
  "↑↓ select · ⏎ open · / filter · n new · a archive · s shelf · x delete · esc back",
  "⏎ open · / filter · n new · a archive · s shelf",
];

/** Restore is the same key as archive — one keypress in, the same keypress back out. */
export const ARCHIVED_HINTS = [
  "↑↓ select · →/⏎ open · a restore · s back to open jobs · x delete · ←/esc back",
  "↑↓ select · ⏎ open · a restore · s open jobs · x delete · esc back",
  "⏎ open · a restore · s open jobs",
];

/** Only these two modes borrow the footer's composer. Engine is not an input — it follows the role. */
const OVERLAYS: Partial<Record<Mode, { placeholder: string; caption: string }>> = {
  create: {
    placeholder: "fix steering",
    caption: "new job · starts an intake thread on claude          ⏎ create · esc",
  },
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
