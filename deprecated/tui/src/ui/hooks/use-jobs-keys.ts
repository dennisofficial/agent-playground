import { clampIndex } from "../../domain/list-nav.js";
import { EJobEntry, type JobEntry } from "../../domain/job-groups.js";
import type { WorktreeGroup } from "../../domain/worktree.js";
import type { JobRow } from "../../store/job.repository.js";
import { EJobAction, type Mode, type View } from "../pages/jobs-chrome.js";
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
  /**
   * What the cursor is on: a job, an empty worktree, or nothing (the `+ new job` row past the end).
   *
   * An ENTRY rather than a job, which is the whole of this change. Every verb below now has to ask
   * what it is looking at before it acts, and that is the point — `x` meaning delete-the-job on one
   * row and remove-the-worktree on another is only safe if one place decides which.
   */
  highlighted: JobEntry<JobRow> | undefined;
  /**
   * What the row past the end of the list is, and therefore what `⏎` does when the cursor is on it:
   * a new job, the project switcher on a first run, or nothing at all on the shelf.
   */
  action: EJobAction | null;
  leaveMode: () => void;
  /** Leaves this page for a blank conversation — the job is created by the message sent there. */
  onNew: () => void;
  /** `⏎` on an empty worktree: the same blank page, with the job's home already decided. */
  onNewIn: (group: WorktreeGroup) => void;
  remove: (job: JobRow) => void;
  /** `x` on an empty worktree: `git worktree remove`, the branch surviving it. */
  releaseWorktree: (group: WorktreeGroup) => void;
  shelve: (job: JobRow) => void;
  setShortcuts: (update: (open: boolean) => boolean) => void;
  onOpen: (job: JobRow) => void;
  onProjects: () => void;
  onBack: () => void;
}): void {
  // The two questions every verb below asks, answered once. A stop is a job or a worktree and never
  // both, so reading it twice in one handler is how the two meanings of `x` would drift apart.
  const job =
    args.highlighted?.kind === EJobEntry.job ? args.highlighted.job : undefined;
  const worktree =
    args.highlighted?.kind === EJobEntry.worktree
      ? args.highlighted.group
      : undefined;
  // `⏎` and `→` past the last row, and `n` — the same door, so it is decided once. A page offering
  // `+ new job` is by definition a page where `n` means one.
  const act = (): void => {
    if (args.action === EJobAction.newJob) return args.onNew();
    if (args.action === EJobAction.pickProject) return args.onProjects();
  };

  useInput((input, key) => {
    if (args.mode === "confirm") {
      // One confirm, two destructions. Which one `y` performs is decided by what the cursor was on
      // when the confirm opened, and the bar above it quotes that same thing — see `jobs.tsx`.
      if (input === "y" && job) return args.remove(job);
      if (input === "y" && worktree) return args.releaseWorktree(worktree);
      return args.leaveMode();
    }

    if (args.mode === "filter") {
      if (key.upArrow) return args.setSelected(clampIndex(args.cursor - 1, args.total));
      if (key.downArrow) return args.setSelected(clampIndex(args.cursor + 1, args.total));
      if (key.escape) return args.leaveMode();
      if (key.return) {
        if (job) {
          args.leaveMode();
          args.onOpen(job);
        } else if (worktree) {
          args.leaveMode();
          args.onNewIn(worktree);
        } else {
          act();
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
    // `→` descends, the exact mirror of `←`. And `⏎` is ONE verb — "go work on the thing under the
    // cursor" — with two spellings: a worktree holding no jobs has nothing to open, and starting a
    // job in it is the only thing the key could mean there.
    //
    // `n` deliberately does NOT follow the cursor. It keeps meaning a plain new job in the project
    // path, so there is always one key whose answer does not depend on where you are standing.
    if (key.return || key.rightArrow) {
      if (job) return args.onOpen(job);
      if (worktree) return args.onNewIn(worktree);
      return act();
    }
    if (input === "/") return args.setMode("filter");
    if (input === "n" && args.action === EJobAction.newJob) return args.onNew();
    // Projects are no longer a level you navigate THROUGH — this list already spans them. The page
    // survives as housekeeping: removing a repo you have stopped working on.
    if (input === "p") return args.onProjects();
    if (input === "x" && args.highlighted) return args.setMode("confirm");
    // Archiving is a job-shaped verb and stays one. A worktree is a place; there is no shelf for it,
    // and hiding one would defeat the only reason it is on this page.
    if (input === "a" && job) return args.shelve(job);
    // The shelf is a separate list rather than a dimmed section: an archived job is one you have
    // decided not to look at, and leaving it in the list you scan defeats archiving it.
    if (input === "s") {
      args.setSelected(0);
      return args.setView((current) => (current === "open" ? "archived" : "open"));
    }
    if (input === "?") return args.setShortcuts((open) => !open);
  });
}
