/**
 * The one line a tile is identified by.
 *
 * Six tiles in one terminal tab means the header is not decoration — it is the only thing telling
 * you which of six unrelated tickets you are looking at. So the shed order INVERTS what a single
 * full-width terminal wanted: the job title is the last thing to go, not the first, and the model
 * and engine go first because they are fixed by the role and you cannot change them from here.
 *
 * Forms are enumerated longest-first and the widest that fits wins, the same rule the hint line and
 * the trail already use. Thresholds would need a number per breakpoint; measuring needs none.
 */

export type HeaderFacts = {
  jobTitle: string;
  repo: string;
  role: string;
  /** Shown only past the first — rotation is invisible until it has happened. */
  sessionOrdinal: number;
  engine: string;
  model: string;
  /** The job's branch when it took a worktree. Null means it works in the project path. */
  branch: string | null;
  /** Other threads of THIS job with a turn in flight. Never other tiles — that is not your business. */
  siblings: number;
  closed: boolean;
};

export type HeaderForm = { left: string; right: string };

/**
 * `⑂` says this job has a tree of its own; `⌂` says it is working in the project path, where your
 * editor is. One character each, because at sixty columns the difference has to cost almost nothing
 * to be worth saying at all.
 */
export const WORKTREE_GLYPH = '⑂';
export const IN_PLACE_GLYPH = '⌂';

function workspace(facts: HeaderFacts, withBranch: boolean): string {
  if (!facts.branch) return IN_PLACE_GLYPH;
  return withBranch ? `${WORKTREE_GLYPH} ${facts.branch}` : WORKTREE_GLYPH;
}

function siblings(facts: HeaderFacts): string {
  // A background thread of your own job finishing unnoticed is the failure this prevents. It is
  // deliberately not a count of other TILES: six unrelated tickets, and that would be noise.
  return facts.siblings > 0 ? `+${facts.siblings}` : '';
}

function role(facts: HeaderFacts): string {
  return facts.sessionOrdinal > 1
    ? `${facts.role} · session ${facts.sessionOrdinal}`
    : facts.role;
}

function join(...parts: (string | null | undefined)[]): string {
  return parts.filter((part) => part && part.length > 0).join('  ');
}

/**
 * Longest-first. The order below IS the shed order, read top to bottom:
 * model → engine → session ordinal → repo → role → branch → worktree glyph → the title truncates.
 */
export function headerForms(facts: HeaderFacts): HeaderForm[] {
  const closed = facts.closed ? 'closed' : '';
  const withRepo = `${facts.repo} › ${facts.jobTitle}`;
  const full = workspace(facts, true);
  const short = workspace(facts, false);

  return [
    { left: join(withRepo, full), right: join(closed, role(facts), siblings(facts), `${facts.engine} ${facts.model}`) },
    { left: join(withRepo, full), right: join(closed, role(facts), siblings(facts), facts.engine) },
    { left: join(withRepo, full), right: join(closed, role(facts), siblings(facts)) },
    { left: join(withRepo, full), right: join(closed, facts.role, siblings(facts)) },
    { left: join(facts.jobTitle, full), right: join(closed, facts.role, siblings(facts)) },
    { left: join(facts.jobTitle, full), right: join(closed, siblings(facts)) },
    { left: join(facts.jobTitle, short), right: join(closed, siblings(facts)) },
    { left: facts.jobTitle, right: join(closed, siblings(facts)) },
    { left: facts.jobTitle, right: closed },
  ];
}

/**
 * The widest form that fits, or the last one — which is the title alone and will be clipped by the
 * renderer rather than dropped. A header with no job title identifies nothing, so there is no form
 * below that one.
 */
export function fitHeader(args: {
  facts: HeaderFacts;
  width: number;
  /** The accent gutter and the space after it, which every form pays for. */
  gutter: number;
}): HeaderForm {
  const forms = headerForms(args.facts);
  const room = args.width - args.gutter;
  const fitting = forms.find(
    (form) => form.left.length + form.right.length + 2 <= room,
  );
  return fitting ?? forms[forms.length - 1] ?? { left: args.facts.jobTitle, right: '' };
}

/**
 * There is deliberately NO per-project accent here.
 *
 * A hashed hue per repository was the first idea and it is the wrong one twice over. The theme
 * holds one accent on purpose, and the only exception it grants is the three court colours — which
 * carry whose move it is, the highest-value signal in the app. A second palette sitting beside them
 * would dilute exactly the thing it sat next to. And it is not needed: one tile is one job, so the
 * job title already identifies the tile, which is why it is the last thing this line will shed.
 */
