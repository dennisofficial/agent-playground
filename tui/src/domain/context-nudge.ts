import { EThreadRole } from '../generated/prisma/enums.js';
import type { Budget, MeterBand } from './usage.js';

/**
 * When Atlas asks for a hand-off, who it asks, and what it says about why.
 *
 * The whole file is one rule: **nudge, never cut.** Nothing here ends a session, and nothing here
 * refuses a turn. The only forced rotation in Atlas is the context wall, which is the API declining
 * the request — a host that cut a session itself would hand the successor a hand-off nobody wrote.
 * An agent that ignores a nudge and keeps working has expressed a judgement about its own remaining
 * runway, which is why there is deliberately no suppression tool: ignoring a nudge already IS
 * suppression, and the cadence escalates instead of giving anyone a mute button.
 */

/**
 * Where a session sits against its budget. Three bands, and the third is not a wall — `hard` only
 * changes the cadence of the asking.
 */
export enum EContextBand {
  normal = 'normal',
  soft = 'soft',
  hard = 'hard',
}

/**
 * Which instrument is driving the `ctx` meter. Two INDEPENDENT measurements that must never be
 * collapsed into one number: the budget is a cost argument (every turn re-sends the transcript, so a
 * 200K session burns the rate-limit windows roughly four times faster than a 50K one), the canary is
 * a quality argument (a standing instruction the session has stopped following). A session can be
 * cheap and confused, or expensive and sharp, and the two situations want different responses.
 */
export enum EContextSignal {
  budget = 'budget',
  canary = 'canary',
}

/**
 * Everything the `ctx` meter draws, and they are three different questions on purpose:
 *
 * - `tokens` is PRINTED, because it is the only figure that means the same thing on every model. A
 *   percentage silently changes what it is a percentage of, and the reader has to remember which.
 * - `percent` fills the BAR — occupancy of the physical window, so the gauge is a picture of how
 *   much room is left.
 * - `band` COLOURS it, from the rotation budget (`pressureBand`), because 300K is calm on a
 *   million-token window and long past the point of handing off.
 */
export type ContextReading = {
  tokens: number;
  percent: number;
  band: MeterBand;
  signal: EContextSignal;
};

/**
 * Who is told. Derived from ONE rule — *tell whoever acts next* — rather than an auto/ask matrix.
 *
 * In `builder`, `task` and the review roles Dennis is not watching: a warning above his composer is
 * noise he reads twenty minutes late, so the nudge goes into the conversation and the agent decides.
 * In the conversational roles the CONVERSATION IS THE ARTIFACT — only the human knows whether the
 * current thread of thought survives a seam — so the nudge is surfaced to him and nothing is said to
 * the agent, which would otherwise volunteer a hand-off in the middle of his sentence.
 *
 * An exhaustive record rather than a lookup with a default: a new role must not silently inherit
 * someone else's audience, and here it fails to compile instead.
 */
export enum ENudgeAudience {
  agent = 'agent',
  human = 'human',
}

export const NUDGE_AUDIENCE: Record<EThreadRole, ENudgeAudience> = {
  generic: ENudgeAudience.human,
  charting: ENudgeAudience.human,
  designer: ENudgeAudience.human,
  planner: ENudgeAudience.human,
  // Opened by another agent and reporting back to it, so the agent is who acts next even though the
  // work is exploratory.
  research: ENudgeAudience.agent,
  prototype: ENudgeAudience.agent,
  task: ENudgeAudience.agent,
  builder: ENudgeAudience.agent,
  plan_review: ENudgeAudience.agent,
  master_review: ENudgeAudience.agent,
  post_build: ENudgeAudience.agent,
  // Both CI roles act without being watched — one writes a pull request description and stops, the
  // other chases a red build — so the nudge belongs in the conversation.
  ship_pr: ENudgeAudience.agent,
  ci: ENudgeAudience.agent,
};

export function audienceFor(role: EThreadRole): ENudgeAudience {
  return NUDGE_AUDIENCE[role];
}

export function contextBand(args: { tokens: number; budget: Budget }): EContextBand {
  if (args.tokens >= args.budget.hard) return EContextBand.hard;
  if (args.tokens >= args.budget.soft) return EContextBand.soft;
  return EContextBand.normal;
}

/**
 * The `ctx` meter's COLOUR: the same three bands the nudge cadence uses, plus a heads-up before the
 * first one. Colour and cadence therefore change together — the moment the meter goes orange is the
 * moment Atlas starts asking, which is one fact for the reader to learn instead of two thresholds
 * to keep in step.
 *
 * `warn` is three quarters of the way to the soft budget: the last stretch where a hand-off is
 * something to plan rather than something being asked for.
 */
const WARN_FRACTION = 0.75;

export function pressureBand(args: { tokens: number; budget: Budget }): MeterBand {
  switch (contextBand(args)) {
    case EContextBand.hard:
      return 'red';
    case EContextBand.soft:
      return 'hot';
    case EContextBand.normal:
      return args.tokens >= args.budget.soft * WARN_FRACTION ? 'warn' : 'normal';
  }
}

/** What has already been said to this session, so the cadence can escalate rather than repeat. */
export type NudgeLedger = { atTokens: number; onTurn: number } | null;

/**
 * The escalating cadence: first at `soft`, then +30K, then every +20K, then every turn past `hard`.
 *
 * It tightens rather than repeating at a fixed interval because a nudge that has been ignored twice
 * is not working and the answer to that is more insistence, not the same insistence. The WORDING
 * escalates on the same ladder — advice through the soft band, the plain request past `hard` — so
 * frequency and register move together rather than one nagging in the other's voice. It is also
 * self-limiting in the way a mute button is not: the interval can only shrink to "once a turn", and
 * a session that keeps working through it is one the human can see on the meter.
 */
const FIRST_GAP = 30_000;
const LATER_GAP = 20_000;

export function decideNudge(args: {
  tokens: number;
  budget: Budget;
  /**
   * A counter that increases once per turn in this session. It is what keeps a forty-tool turn from
   * being told forty times: the escalation happens ACROSS turns, and inside one turn the agent has
   * already been told.
   */
  turn: number;
  last: NudgeLedger;
}): boolean {
  const band = contextBand(args);
  if (band === EContextBand.normal) return false;
  if (!args.last) return true;
  if (args.turn === args.last.onTurn) return false;
  if (band === EContextBand.hard) return true;
  const gap = args.last.atTokens >= args.budget.soft + FIRST_GAP ? LATER_GAP : FIRST_GAP;
  return args.tokens - args.last.atTokens >= gap;
}

/** `178K`, `1.2M` — a token count at the precision anyone actually reads it to. */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  return `${Math.round(tokens / 1_000)}K`;
}

/**
 * The one sentence prepended to whichever thing Atlas is saying — `handoffAdvisory` at `soft`,
 * `rotationRequest` at `hard`.
 *
 * It is a REASON, not an instruction: everything about what to do lives in those two, so there is
 * one wording of each speech act and one place to get each right. This says only why Atlas is
 * speaking now, and its own escalation at `hard` is the reason line matching the harder ask.
 */
export function nudgeReason(args: { tokens: number; budget: Budget }): string {
  const at = `This session is at ${formatTokens(args.tokens)} of a ${formatTokens(args.budget.soft)} budget`;
  if (contextBand(args) === EContextBand.hard) {
    return `${at} — well past the point where a hand-off is cheaper than another turn, and every turn from here re-sends the whole transcript.`;
  }
  return `${at}.`;
}

/**
 * Said to the HUMAN, once, whatever the thread's audience is — and never to the agent.
 *
 * A dead canary is the one reading that says asking may no longer work: the session has stopped
 * following a trivial standing instruction, and the request to rotate is a standing instruction too.
 * Telling the agent louder is the one response that certainly does not help, and Atlas still does
 * not cut. So the person who can act is told, and given the verb.
 */
export const CANARY_NOTICE =
  'this session has stopped following a standing instruction — three of its last five turns · /rotate opens a fresh one on the same work';

/** The same fact for the human, who is looking at a meter rather than reading a paragraph. */
export function nudgeNotice(args: { tokens: number; budget: Budget }): string {
  const over = contextBand(args) === EContextBand.hard ? ' · well over' : '';
  return `context ${formatTokens(args.tokens)} of ${formatTokens(args.budget.soft)}${over} · /rotate hands this thread to a fresh session`;
}
