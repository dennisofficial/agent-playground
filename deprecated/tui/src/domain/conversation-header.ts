/**
 * The two lines a conversation is identified by, and what they shed as the terminal narrows.
 *
 * Six tiles in one terminal tab means the header is not decoration — it is the only thing telling
 * you which of six unrelated tickets you are looking at, and whether the one in front of you is
 * waiting on you. Each row has exactly one job:
 *
 *   row 1   WHAT this is, and WHAT IS HAPPENING     title · status + clock
 *   row 2   WHERE it lives, and WHO is on it        repo · place  ·  role · siblings
 *
 * The model and the session ordinal are deliberately NOT here. They live in the footer beside the
 * `ctx` meter, because that meter is the model's own window and the ordinal is why it last reset;
 * on this line's right edge they were two orphans crowding out the status.
 *
 * Everything below is pure text: no colours, no spans, no terminal. Forms are enumerated
 * longest-first and the widest that fits wins — the same rule the hint line and the trail use.
 * Thresholds would need a number per breakpoint; measuring needs none.
 */

import type { EAttentionCourt } from './attention.js';

/** Where a job's turns run, as GIT answers it — never as Atlas recorded it. */
export type HeaderGit = {
  /**
   * The directory turns run in, relative to the repository root. Null means the root itself.
   *
   * Relative rather than absolute because the only question this answers is "is the agent writing
   * into the tree I have an editor open on", and an absolute path buries that under a home
   * directory.
   */
  cwdLabel: string | null;
  /** What `git branch --show-current` answers there. Null is a detached HEAD, or no repository. */
  checkoutBranch: string | null;
};

/** Whose move it is, in the vocabulary `attentionFor` already fixed for the job and thread lists. */
export type HeaderStatus = {
  label: string;
  court: EAttentionCourt;
  spinner: boolean;
};

export type HeaderFacts = {
  jobTitle: string;
  repo: string;
  role: string;
  /** Other threads of THIS job with a turn in flight. Never other tiles — that is not your business. */
  siblings: number;
  closed: boolean;
  status: HeaderStatus;
  git: HeaderGit;
};

/**
 * Turns run in the repository root — the tree the human has an editor open on. This is the one
 * case worth flinching at, which is why it gets a glyph of its own rather than an absence.
 */
export const IN_PLACE_GLYPH = '⌂';
/**
 * Turns run somewhere else.
 *
 * Deliberately NOT "Atlas gave this job a worktree". Atlas orchestrates agents; it does not run the
 * repository. The directory may be a worktree Atlas minted, one the agent made with `git worktree
 * add`, or somewhere nobody planned — a distinction this line cannot honestly draw and has no
 * business drawing. All it claims is: not the tree your editor is on.
 */
export const ELSEWHERE_GLYPH = '⑂';

/** What git says, when git has not been asked yet or has no answer. */
export const DETACHED = 'detached';

export type HeaderPlace = {
  glyph: string;
  /** Dropped when it repeats the branch — see `headerPlace`. */
  path: string | null;
  branch: string;
};

/**
 * Row 2's left: where this agent is standing, and what it will commit onto.
 *
 * The path is dropped when it says nothing the branch has not. An Atlas-minted worktree lives at
 * `.worktrees/<slug>-<id8>` on branch `atlas/<slug>-<id8>`, so printing both prints it twice — and
 * the pair is nearly a hundred columns. A worktree whose directory and branch actually differ keeps
 * both, because then each is news.
 */
export function headerPlace(git: HeaderGit): HeaderPlace {
  const branch = git.checkoutBranch ?? DETACHED;
  if (git.cwdLabel === null) return { glyph: IN_PLACE_GLYPH, path: null, branch };

  const leaf = git.cwdLabel.split('/').filter(Boolean).pop();
  const tail = branch.split('/').pop();
  const repeats = leaf !== undefined && leaf === tail;
  return {
    glyph: ELSEWHERE_GLYPH,
    path: repeats ? null : git.cwdLabel,
    branch,
  };
}

/**
 * Row 1's right: what is happening, or that nothing can.
 *
 * `closed` outranks the court because a closed thread cannot be acted on at all — the composer will
 * not send — and that is a different kind of fact from whose turn it is.
 *
 * `elapsed` arrives pre-formatted so this module stays free of the renderer's clock helpers.
 */
export function headerStatusText(args: {
  facts: Pick<HeaderFacts, 'closed' | 'status'>;
  elapsed: string | null;
}): string {
  if (args.facts.closed) return 'closed';
  const { label, spinner } = args.facts.status;
  return spinner && args.elapsed !== null ? `${label} ${args.elapsed}` : label;
}

export enum EHeaderChip {
  role = 'role',
  siblings = 'siblings',
}

export type HeaderChip = { kind: EHeaderChip; text: string };

/**
 * Row 2's right, longest-first.
 *
 * The role never goes: it is what this agent will DO, and a thread whose role you cannot see is a
 * thread you have to guess about. The sibling count sheds its word before it sheds its number,
 * because a background thread of your own job finishing unnoticed is the failure this prevents and
 * `+2` still prevents it.
 */
export function headerChipForms(facts: Pick<HeaderFacts, 'role' | 'siblings'>): HeaderChip[][] {
  const role: HeaderChip = { kind: EHeaderChip.role, text: facts.role };
  if (facts.siblings === 0) return [[role]];
  return [
    [role, { kind: EHeaderChip.siblings, text: `+${facts.siblings} threads` }],
    [role, { kind: EHeaderChip.siblings, text: `+${facts.siblings}` }],
    [role],
  ];
}

/** How wide a set of chips draws, joined by the renderer's ` · `. */
export function chipsWidth(chips: HeaderChip[], separator = 3): number {
  if (chips.length === 0) return 0;
  const text = chips.reduce((sum, chip) => sum + chip.text.length, 0);
  return text + separator * (chips.length - 1);
}

/** The widest set that fits, or the role alone — which is clipped by the renderer, never dropped. */
export function fitHeaderChips(args: {
  facts: Pick<HeaderFacts, 'role' | 'siblings'>;
  room: number;
}): HeaderChip[] {
  const forms = headerChipForms(args.facts);
  const fitting = forms.find((form) => chipsWidth(form) <= args.room);
  return fitting ?? forms[forms.length - 1] ?? [];
}
