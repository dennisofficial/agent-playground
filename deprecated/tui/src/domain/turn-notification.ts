import { EAttentionCourt, EAttentionVerb, type Attention } from './attention.js';

/**
 * A desktop notification, decided.
 *
 * **Who notifies is settled structurally, not by a lock.** The engine runs in-process, so a turn
 * belongs to exactly one Atlas instance — the one whose `TurnRunnerService` holds its lane. Several
 * instances are normal here, and the naive design (watch the derived attention state, notify when it
 * changes) would have every instance fire for every job. Driving this from the LOCAL lane set
 * instead means the process that ran the agent is the only one that can see the turn end, and the
 * work is already split across processes by the time anybody asks. No claim file, no coordination,
 * no de-duplication step that can be wrong.
 *
 * The corollary is worth stating because it looks like a bug: a job whose turns are being run by
 * another terminal produces no notification HERE, and should not. That terminal is running the
 * agent, and it is the one that will say so.
 */

export type TurnNotification = {
  /** The banner's heading. The job, because that is what the human is being called back to. */
  title: string;
  message: string;
};

/**
 * Turns that ENDED in this process since the last reading.
 *
 * Departures from the lane set, not arrivals: a turn starting is not news, and the whole signal here
 * is the moment an agent stops and the ball is left somewhere.
 */
export function finishedThreads(args: {
  before: readonly string[];
  now: readonly string[];
}): string[] {
  const running = new Set(args.now);
  return args.before.filter((threadId) => !running.has(threadId));
}

/**
 * Whether a finished turn is worth interrupting the human for, and what to say.
 *
 * **The precedence is not re-decided here.** `attentionFor` already ranks the verbs — `confirm`
 * outranks `working…` because a running turn resolves itself and a pending proposal never does —
 * and the court it derives is exactly the question a notification asks: *is the ball with me?* So
 * this reads that answer rather than re-deriving one, which is what stops a second ordering table
 * from existing and drifting.
 *
 * Two things make it null:
 *
 * - **The court is not yours.** Another thread of this job is still working, or the job is waiting
 *   on GitHub. Notifying then would be a banner for something you cannot act on, and the one that
 *   matters would arrive later and read identically.
 * - **You are already looking at it.** The transcript is on screen and about to render the very
 *   thing the banner would announce.
 *
 * Job scope rather than thread scope, deliberately. A notification names a job and pulls you back to
 * one; the thread you land on is the cursor's business, and at thread scope a finished last thread
 * reads `closed · nobody's court` when the honest answer to "does this need me" is yes.
 */
export function turnNotification(args: {
  jobTitle: string;
  attention: Attention;
  /** The human is watching this very thread — the one case where the screen beats the banner. */
  onScreen: boolean;
}): TurnNotification | null {
  if (args.onScreen) return null;
  if (args.attention.court !== EAttentionCourt.yours) return null;

  const message = MESSAGES[args.attention.verb];
  if (!message) return null;
  return { title: args.jobTitle, message };
}

/**
 * A sentence, where the status column has a verb.
 *
 * The list says `confirm` because it is a column two words wide beside a row you are already
 * looking at. A banner arrives with no such context and is read once, out of the corner of an eye,
 * possibly hours later — so it says what happened rather than what to type. Same states, different
 * reading distance; sharing the strings would make one of the two wrong.
 *
 * `working` and `shipped` are absent rather than mapped: neither leaves the ball in your court, so
 * `turnNotification` has already returned by the time this is read. Absent, not unreachable-throwing
 * — a state that somehow arrived here should produce silence, not a crash inside a notification.
 */
const MESSAGES: Partial<Record<EAttentionVerb, string>> = {
  [EAttentionVerb.confirm]: 'wants your confirmation',
  [EAttentionVerb.reply]: 'is waiting on you',
  [EAttentionVerb.nothingOpen]: 'has nothing open',
};
