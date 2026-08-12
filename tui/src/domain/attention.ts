/**
 * Whose court is the ball in, and what do you owe it.
 *
 * A row's condition is DERIVED from five parse-free facts, never stored — the same reason
 * `Job.status` was deleted rather than reduced: every value it could hold was already readable
 * somewhere else, and the same bit in two places drifts.
 *
 * Two independent channels, measured against three candidate renderings across all 24 legal
 * fact-combinations:
 *
 * - **shape** says whether you have READ it (`●` unseen · `·` seen)
 * - **colour** says whose court it is in (agent · yours · external)
 * - the **word** names the action you owe, with the spinner in front of it
 *
 * Collapsing the two into one word costs three collisions: a single `● new` swallows an unseen
 * proposal, an unseen question, an unseen "nothing is open" and an unseen "the PR is up" — it
 * discards the reason exactly when the reason is newest. Do not re-merge them.
 *
 * "Who spoke last" is deliberately NOT a fact here: an agent works until it responds, so at rest
 * the agent has always spoken last and the bit carries no information. Read state does.
 */

/**
 * The same function draws a thread row and a job row. The one place the level matters is when
 * nothing is open: a job can be given a new phase, a thread is simply history and owes nothing.
 */
export enum EAttentionScope {
  thread = 'thread',
  job = 'job',
}

export enum EAttentionVerb {
  /** A proposal is waiting for a keypress. */
  confirm = 'confirm',
  /** A turn is in flight. */
  working = 'working',
  /** Something is open and the last word was the agent's. */
  reply = 'reply',
  /** Nothing is open — the end of a leg, or the end of the job. */
  nothingOpen = 'nothingOpen',
  /** Nothing is open and a pull request exists: it is out of this machine's hands. */
  shipped = 'shipped',
}

export enum EAttentionCourt {
  agent = 'agent',
  yours = 'yours',
  external = 'external',
  /** Nobody's — history, which is dim rather than coloured. */
  none = 'none',
}

/** The five facts. None of them requires reading a word of prose. */
export type AttentionFacts = {
  /** The turn runner's live lane set. */
  turnRunning: boolean;
  /** A pending `Transition` row. */
  proposalPending: boolean;
  /** Threads not closed. At thread scope this is 1 or 0 — the thread itself. */
  openThreadCount: number;
  /** Newest message newer than `Thread.lastSeenAt`. */
  unseen: boolean;
  /** `Job.prNumber != null`. */
  hasPullRequest: boolean;
};

export type Attention = {
  verb: EAttentionVerb;
  /** What the status column says, without the spinner. */
  label: string;
  court: EAttentionCourt;
  /**
   * Read state as the dot draws it. Suppressed while a turn is running: text still being produced
   * needs no go-read-this, and the row already says `working…`. One of the two benign collisions
   * the prototype measured, and the right one.
   */
  unseen: boolean;
  /** Whether the status column carries a spinner in front of its verb. */
  spinner: boolean;
};

export const NO_FACTS: AttentionFacts = {
  turnRunning: false,
  proposalPending: false,
  openThreadCount: 0,
  unseen: false,
  hasPullRequest: false,
};

/**
 * `confirm` outranks `working…`, and this is the whole ordering argument: **a running turn resolves
 * itself without you, a pending proposal never does.** With it the other way round a job whose
 * planner is waiting on a keypress reads as busy, and you find out only when nothing is working any
 * more. The case is unreachable on one thread — the turn that raised the proposal has ended — and
 * appears the moment a job unions its threads.
 */
export function attentionFor(args: {
  facts: AttentionFacts;
  scope: EAttentionScope;
}): Attention {
  const { facts } = args;
  const verb = verbFor(facts);
  return {
    verb,
    label: verbLabel({ verb, scope: args.scope }),
    court: courtFor({ verb, scope: args.scope }),
    unseen: facts.unseen && !facts.turnRunning,
    spinner: verb === EAttentionVerb.working,
  };
}

function verbFor(facts: AttentionFacts): EAttentionVerb {
  if (facts.proposalPending) return EAttentionVerb.confirm;
  if (facts.turnRunning) return EAttentionVerb.working;
  if (facts.openThreadCount === 0) {
    return facts.hasPullRequest ? EAttentionVerb.shipped : EAttentionVerb.nothingOpen;
  }
  return EAttentionVerb.reply;
}

function verbLabel(args: { verb: EAttentionVerb; scope: EAttentionScope }): string {
  if (args.verb === EAttentionVerb.nothingOpen) {
    // The only scope-dependent word. A job with nothing open is a prompt; a thread with nothing
    // open is a record, and labelling twelve finished legs `start a phase` would shout at history.
    return args.scope === EAttentionScope.job ? 'start a phase' : 'closed';
  }
  return LABELS[args.verb];
}

const LABELS: Record<EAttentionVerb, string> = {
  [EAttentionVerb.confirm]: 'confirm',
  [EAttentionVerb.working]: 'working…',
  [EAttentionVerb.reply]: 'reply',
  [EAttentionVerb.nothingOpen]: 'start a phase',
  [EAttentionVerb.shipped]: 'shipped',
};

function courtFor(args: {
  verb: EAttentionVerb;
  scope: EAttentionScope;
}): EAttentionCourt {
  switch (args.verb) {
    case EAttentionVerb.working:
      return EAttentionCourt.agent;
    case EAttentionVerb.shipped:
      return EAttentionCourt.external;
    case EAttentionVerb.nothingOpen:
      return args.scope === EAttentionScope.job
        ? EAttentionCourt.yours
        : EAttentionCourt.none;
    default:
      return EAttentionCourt.yours;
  }
}

/**
 * A job row is one row over N threads: union the facts and run the SAME function. No second
 * ordering table to keep in sync — the ordering inside the verb already encodes *a keypress you owe
 * beats a conversation you owe*. `openThreadCount` counts threads, so a job says how many legs are
 * live while a thread only ever says whether it is one of them.
 */
export function unionFacts(facts: readonly AttentionFacts[]): AttentionFacts {
  return {
    turnRunning: facts.some((fact) => fact.turnRunning),
    proposalPending: facts.some((fact) => fact.proposalPending),
    openThreadCount: facts.filter((fact) => fact.openThreadCount > 0).length,
    unseen: facts.some((fact) => fact.unseen),
    hasPullRequest: facts.some((fact) => fact.hasPullRequest),
  };
}

/**
 * `⠹ working…` — the status column's whole content, built the same way at both levels.
 *
 * The spinner is IN FRONT OF the verb rather than in the dot's place, which is what lets a job say
 * "something is running here" and "you owe a keypress" at the same time. While it replaced the dot,
 * those two were the same pixel and one of them had to lose.
 */
export function statusCell(args: { attention: Attention; frame: string }): string {
  const { attention } = args;
  return attention.spinner ? `${args.frame} ${attention.label}` : attention.label;
}

/**
 * Which fact-combinations can actually occur — asserted by the tests rather than enforced here, so
 * an impossible row still renders something instead of throwing at the user.
 *
 * A running turn needs an open thread; a proposal is raised BY a thread; and a turn that raised a
 * proposal has, by definition, ended.
 */
export function isLegal(facts: AttentionFacts): boolean {
  if (facts.turnRunning && facts.openThreadCount === 0) return false;
  if (facts.proposalPending && facts.openThreadCount === 0) return false;
  return !(facts.turnRunning && facts.proposalPending);
}
