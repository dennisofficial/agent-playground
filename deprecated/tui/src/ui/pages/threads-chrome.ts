/**
 * The job page's hint lines — split out the way the jobs page splits into `jobs-chrome.ts`, because
 * what a page DOES is its keyboard contract and four forms of one sentence sitting next to it is
 * furniture.
 *
 * Longest-first, and the widest that fits wins — these measure, they do not threshold.
 *
 * The verbs are advertised here rather than in a keymap panel because this page has never had one:
 * the hint line holds them, and a job with nothing running has to SHOW that `p` and `n` exist or
 * the state is a dead end that looks like a bug. `r` joins them for the same reason — a title
 * nobody can see how to change reads as a title you are stuck with.
 */
export const HINTS = [
  "↑↓ select · →/⏎ open · p start a phase · n new thread · c close · r rename · ←/esc back",
  "↑↓ select · ⏎ open · p phase · n thread · c close · r rename · esc back",
  "⏎ open · p phase · n thread · r rename · esc back",
  "⏎ open · p phase · n thread · esc back",
];

/** `w` is offered only where it does something — a job already in a worktree cannot take another. */
export const IN_PLACE_HINTS = [
  "↑↓ select · →/⏎ open · p start a phase · n new thread · c close · r rename · w worktree · ←/esc back",
  "↑↓ select · ⏎ open · p phase · n thread · c close · r rename · w worktree · esc back",
  "⏎ open · p phase · n thread · r rename · w worktree · esc",
  "⏎ open · p phase · n thread · w worktree · esc",
];
