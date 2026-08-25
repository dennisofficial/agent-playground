/**
 * The words of the session seam: what a rotating agent writes, the two things Atlas says to get it
 * (`handoffAdvisory` then `rotationRequest`), and what the successor is told when the wall arrived
 * before the hand-off did.
 *
 * All pure, because every one of them is a string a test can read back. Nothing here knows what a
 * session is — `app/session-rotation.ts` owns the act, this owns the payload.
 */

/**
 * The progress report, as four typed fields rather than one prose blob.
 *
 * The schema is the only rail: a single free-text argument reliably comes back as a summary of what
 * happened, and *tried and rejected* — the section no other harness has, and the one that stops the
 * successor re-running the predecessor's worst hour — is the first thing an agent under context
 * pressure drops. Asking for it by name is the whole mechanism.
 */
export type RotationSections = {
  /** What actually landed, and how it was verified. */
  done: string;
  /** Dead ends WITH their reasons. The lesson survives; the flailing is dropped. */
  triedAndRejected: string;
  /** What the codebase did that the spec did not say. */
  surprises: string;
  /** Where to pick up, concretely enough to act on without re-reading the transcript. */
  next: string;
  /** The escape hatch for anything outside the frame. Absent when there was nothing. */
  notes?: string;
};

/**
 * The stored hand-off, verbatim from the agent — headed sections and nothing else.
 *
 * Atlas never rewrites or summarises what it is given here: the successor is entitled to its
 * predecessor's own words, and a host paraphrase of a session that ran out of room is lossy in
 * exactly the places it is needed.
 */
export function renderRotationHandoff(args: {
  sections: RotationSections;
  /**
   * The thread's task list, already rendered. The one thing in a hand-off the agent does not write:
   * tasks outlive the session, so the next leg inherits ids it has never seen and would otherwise
   * update `#3` blind. Appended rather than folded into a section, because it is a render of state
   * rather than a claim about it.
   */
  tasks?: string;
}): string {
  const { sections } = args;
  const parts = [
    `## Done\n\n${sections.done.trim()}`,
    `## Tried and rejected\n\n${sections.triedAndRejected.trim()}`,
    `## Surprises\n\n${sections.surprises.trim()}`,
    `## Next\n\n${sections.next.trim()}`,
  ];
  const notes = sections.notes?.trim();
  if (notes) parts.push(`## Notes\n\n${notes}`);
  const tasks = args.tasks?.trim();
  if (tasks) parts.push(tasks);
  return parts.join('\n\n');
}

/**
 * The SOFT tier: Atlas has noticed, and the agent picks the moment.
 *
 * This exists because "rotate now, before doing any more work" is the wrong first thing to say. A
 * budget crossing lands wherever it lands — mid-edit, between a change and the test that proves it,
 * three files into a refactor — and an agent that obeys immediately hands its successor a
 * half-applied change, which is a strictly worse inheritance than the twenty thousand tokens
 * stopping early saved. Only the agent can see where its own seam is, so the timing is given to it.
 *
 * It is deliberately NOT a rewording of `rotationRequest`. It is a different speech act: no action
 * is demanded on this turn, and the escalation to the imperative version at `hard` is what keeps the
 * discretion from being open-ended. The cost of ignoring it is named for the same reason — advice
 * without a consequence is a suggestion the model is right to deprioritise.
 *
 * The four sections are not restated here; `rotate`'s own tool description carries them, and a short
 * advisory is what makes this read as advice rather than a quieter order.
 */
export function handoffAdvisory(args?: { reason?: string }): string {
  const reason = args?.reason?.trim();
  return [
    reason ??
      'This session is approaching the point where handing over costs less than another turn.',
    '',
    'You are not being asked to stop. Finish what you are in the middle of — an interrupted edit or a',
    'change you have not verified yet is a worse thing to hand over than a few thousand extra tokens,',
    'and you are the only one who can see where the seam is.',
    '',
    'When you reach it — a task done, a test green, a question answered — call `rotate` before',
    'starting the next thing, rather than opening work you would not want to hand over mid-flight.',
    '',
    'Nothing is lost by rotating: the work, the files and the thread all continue. Only the window',
    'turns over. If you keep going instead, Atlas will ask again and more insistently, and past a',
    'point the API refuses the request outright — that is the one hand-off nobody gets to write.',
  ].join('\n');
}

/**
 * The HARD tier, and what `/rotate` sends: the advice has not been taken, so Atlas asks plainly.
 *
 * The manual path and the escalated nudge are ONE path deliberately: both ask the agent to call
 * `rotate`, so there is a single implementation of what a rotation is and a single place its
 * wording can be got right. Atlas never cuts the session out from under a working agent — the
 * request is the mechanism, and the tool call is the act.
 *
 * Typing `/rotate` starts HERE rather than at the advisory, and that asymmetry is the point: the
 * meter guessing at pressure earns a suggestion, a human asking for a hand-off has already made the
 * judgement call the advisory exists to defer to.
 */
export function rotationRequest(args?: { reason?: string }): string {
  const reason = args?.reason?.trim();
  return [
    reason ?? 'You have been asked to hand this session over.',
    '',
    'Call `rotate` now, before doing any more work. Write the four sections for the agent that picks',
    'this up next — it is you, in a fresh context window, with none of this conversation: what landed',
    'and how you verified it, what you tried and rejected and why, what surprised you about this',
    'codebase, and what to do next. Attach anything from the job folder it should not start without.',
    '',
    'Nothing is lost by rotating: the work, the files and the thread all continue. Only the window',
    'turns over.',
  ].join('\n');
}

/**
 * The successor's first message when the previous leg hit the wall and never got to hand over.
 *
 * It points at the transcript rather than carrying a host-written summary. Nothing was lost but the
 * summary — the dead session's messages are all in Atlas's store — and the reader is far better
 * placed to write it than the harness is: a faithful summary of a confused session is a confident
 * confused summary, which is precisely the poisoned trajectory rotation exists to drop.
 */
export function contextWallStub(args: {
  threadId: string;
  /** The leg that died, so the successor knows which seam to read up to. */
  ordinal: number;
}): string {
  return [
    `The session before this one (leg ${args.ordinal}) hit the context wall: the API refused the`,
    'request because the transcript itself had grown too long, so it never got the chance to hand',
    'over. Nothing is lost but the summary — every message it wrote is still in Atlas’s store.',
    '',
    `Before anything else, run \`atlas transcript ${args.threadId} --full\` and read leg ${args.ordinal}`,
    '— it ends at the seam this message opens. Then write the hand-off it never wrote, in your own',
    'first message here: what landed, what was tried and rejected, what surprised you, what is next.',
    '',
    'Atlas deliberately did not summarise it for you. You are the one who has to act on it.',
  ].join('\n');
}

/**
 * Patterns that mean *this transcript is too long for another request*, and nothing else.
 *
 * Deliberately narrow. A context wall is the ONE failure that forces a rotation, because every
 * retry re-sends the same oversized transcript and fails identically; an ordinary engine crash
 * leaves the transcript intact and resuming costs nothing, so rotating on it would throw away a
 * healthy context for no reason. Anything not matched here is treated as the second kind.
 */
const WALL_PATTERNS: readonly RegExp[] = [
  // Anthropic: `prompt is too long: 213043 tokens > 200000 maximum`
  /prompt is too long/i,
  // Anthropic: `input length and \`max_tokens\` exceed context limit: 190000 + 32000 > 200000`
  /exceeds? [^.]*context[ _-](?:length|window|limit)/i,
  // OpenAI-shaped, which is where Codex will land: `context_length_exceeded`
  /context[ _-](?:length|window|limit)[ _-]exceeded/i,
  /maximum context (?:length|window)/i,
];

/** True only for the context wall — see `WALL_PATTERNS`. */
export function isContextWall(error: {
  title: string;
  detail?: string | undefined;
}): boolean {
  const text = `${error.title} ${error.detail ?? ''}`;
  return WALL_PATTERNS.some((pattern) => pattern.test(text));
}
