import { clampIndex } from "../../domain/list-nav.js";
import type { JobRow } from "../../store/job.repository.js";
import type { Mode, View } from "../pages/jobs-chrome.js";
import type { ComposerControls } from "./use-composer.js";
import { useInput } from "./use-input.js";

/**
 * The job list's keyboard contract, in one place.
 *
 * Apart from the page for the same reason the conversation's is: three modes share one listener, and
 * which of them owns a keypress is the whole of the page's behaviour. Reading that with the JSX in
 * between hides the one thing worth checking — that exactly one mode claims each key.
 *
 * Flat named arguments, each read once below. Grouping them would only add a layer to look through
 * while tracing a key.
 */
export function useJobsKeys(args: {
  mode: Mode;
  setMode: (mode: Mode) => void;
  view: View;
  setView: (update: (current: View) => View) => void;
  composer: ComposerControls;
  cursor: number;
  total: number;
  setSelected: (index: number) => void;
  highlighted: JobRow | undefined;
  /** False on the shelf and on the unscoped list, where there is no "here" to create a job in. */
  canCreate: boolean;
  leaveMode: () => void;
  /** Leaves this page for a blank conversation — the job is created by the message sent there. */
  onNew: () => void;
  remove: (job: JobRow) => void;
  shelve: (job: JobRow) => void;
  setShortcuts: (update: (open: boolean) => boolean) => void;
  onOpen: (job: JobRow) => void;
  onProjects: () => void;
  onBack: () => void;
}): void {
  useInput((input, key) => {
    if (args.mode === "confirm") {
      if (input === "y" && args.highlighted) return args.remove(args.highlighted);
      return args.leaveMode();
    }

    if (args.mode === "filter") {
      if (key.upArrow) return args.setSelected(clampIndex(args.cursor - 1, args.total));
      if (key.downArrow) return args.setSelected(clampIndex(args.cursor + 1, args.total));
      if (key.escape) return args.leaveMode();
      if (key.return) {
        if (args.highlighted) {
          args.leaveMode();
          args.onOpen(args.highlighted);
        } else if (args.canCreate) {
          args.onNew();
        }
        return;
      }
      args.composer.handleKey(input, key);
      return;
    }

    // `←` and `esc` are the same door. On a list there is nothing for `←` to mean other than "out",
    // and reaching for it is the reflex a two-pane file browser trains. At the unscoped root there
    // is nothing behind it, and `pop` declines rather than emptying the stack.
    if (key.escape || key.leftArrow) return args.onBack();
    if (key.upArrow) return args.setSelected(clampIndex(args.cursor - 1, args.total));
    if (key.downArrow) return args.setSelected(clampIndex(args.cursor + 1, args.total));
    // `→` descends, the exact mirror of `←`.
    if (key.return || key.rightArrow) {
      if (args.highlighted) return args.onOpen(args.highlighted);
      if (args.canCreate) return args.onNew();
      return;
    }
    if (input === "/") return args.setMode("filter");
    if (input === "n" && args.canCreate) return args.onNew();
    // Projects are no longer a level you navigate THROUGH — this list already spans them. The page
    // survives as housekeeping: removing a repo you have stopped working on.
    if (input === "p") return args.onProjects();
    if (input === "x" && args.highlighted) return args.setMode("confirm");
    if (input === "a" && args.highlighted) return args.shelve(args.highlighted);
    // The shelf is a separate list rather than a dimmed section: an archived job is one you have
    // decided not to look at, and leaving it in the list you scan defeats archiving it.
    if (input === "s") {
      args.setSelected(0);
      return args.setView((current) => (current === "open" ? "archived" : "open"));
    }
    if (input === "?") return args.setShortcuts((open) => !open);
  });
}
