/**
 * prompt-kit / turns / build-handoff — the LEG-ROTATION handoff prompts (the builder analog of the brain's
 * compaction `CONTINUATION_PREAMBLE`). One build Thread spans many sequential engine sessions ("Legs"); when the
 * anchor step's live session fills past the SOFT occupancy threshold we nudge the builder to ROTATE: author a
 * structured handoff, abandon the fat session, and seed a FRESH one with that handoff (the WIP survives on disk
 * in the shared worktree). See the plan `~/.claude/plans/context-rot-is-real-immutable-sedgewick.md` (Part B4).
 *
 * The handoff is ALWAYS self-authored: the live builder calls the `record_leg_handoff` host tool (steered toward
 * it by the SOFT nudge + the delta REMINDERS below) and yields. There is NO forced/fallback handoff — if the
 * builder ignores every nudge it simply keeps running in the same session (no rotation).
 *
 * WHERE THE SCHEMA LIVES: the in-container Claude bridge advertises host tools with a GENERIC MCP description, so
 * the builder never reads {@link RECORD_LEG_HANDOFF_DESCRIPTION}. The handoff QUALITY bar therefore has to ride
 * the NUDGE text (which IS injected into the live turn) — hence {@link HANDOFF_SCHEMA} is embedded directly in
 * {@link ROTATION_SOFT_NUDGE}. Keep the schema THERE, not only in the tool description.
 *
 * WHERE THE HANDOFF GOES: on rotation the host also writes the handoff to `/context/generated/handoffs/leg-<N>.md`
 * — a durable, inspectable artifact OUTSIDE the git worktree (never a dirty commit / PR file). The fresh Leg is
 * seeded with the handoff text inline AND can re-read that file. A builder's durable state is the WORKTREE (not
 * `/context/specs`), so the schema leans on "what's on disk, by path+status" and KEEPS failed attempts verbatim.
 */

import { renderHarnessTag } from '../harness/tag-vocabulary';
import { agentMessage, fromExternal, type AgentMessage } from '../message';

/**
 * The structured handoff schema — the contract for a SOLID handoff. A fresh session must be able to CONTINUE
 * from it with zero loss and without re-deriving anything. Concrete over vague: real paths, real errors, exit
 * codes, ONE next step. Embedded in {@link ROTATION_SOFT_NUDGE} (the text the builder actually reads).
 */
export const HANDOFF_SCHEMA = [
  '1. Scope & files — every file you touched, by path, each with a one-word status: done / WIP / not-started.',
  '2. Failed attempts — every approach that did NOT work, WITH its verbatim error text. Never drop an error:',
  '   the fresh session needs it so it does not walk back into the same dead end.',
  '3. On-disk state NOW — exactly what is committed vs uncommitted WIP in the worktree; name the current commit SHA.',
  '4. Decisions — choices you made this session that are not already written into `/context/specs`.',
  '5. Verification — commands you ran, their exit codes, and the tail of their output (evidence, not claims).',
  '6. Next safe action — the SINGLE concrete next step the fresh session should take. One step, not a plan.',
  '7. Open questions — each with the options you were weighing, so the next session neither re-derives nor re-asks.',
  '8. Pointers — the durable artifacts to re-read (`/context/specs`, the commit SHA). Reference',
  '   them by path; do not re-transcribe them.',
];

/**
 * Prepended to the handoff when it seeds the FRESH Leg (folded into the next batch task by the driver). Frames
 * the handoff as recovered memory and tells the session to CONTINUE, not restart. Analog of `CONTINUATION_PREAMBLE`.
 */
export const ROTATION_PREAMBLE = agentMessage(
  renderHarnessTag({
    tag: 'session_rotated',
    body: [
      'Your previous build session filled its context window and was rotated to keep you sharp. Its handoff is below',
      '(also saved verbatim at `/context/generated/handoffs/` if you want to re-read it). Treat it as your OWN',
      'recovered memory. Your work-in-progress from that session is ALREADY ON DISK in this worktree — do NOT restart',
      'the batch, do NOT redo work that is already committed or staged, and do NOT re-ask or re-derive anything the',
      'handoff already settles. Re-read the durable artifacts it points to as needed (`/context/specs`,',
      '`get_pipeline_state`), then continue from its "Next safe action".',
    ].join('\n'),
  }),
);

/**
 * Appended AFTER the original batch task when a seed is folded — the recency-slot complement to the primacy-slot
 * {@link ROTATION_PREAMBLE}. LLM attention is U-shaped (strong at the start AND end, weak in the middle), so the
 * fresh Leg's operative INSTRUCTION belongs last, where recall is highest — while the handoff/checklist keep the
 * primacy slot up top. This is an instruction, NOT a relocated state-dump: it re-anchors the Leg on the handoff's
 * single "Next safe action", points it at its OWN spec section (selective re-read, not every spec — the fresh Leg
 * has a fresh budget to protect), and reiterates continue-don't-restart.
 */
export const ROTATION_RESUME_TAIL = agentMessage(
  renderHarnessTag({
    tag: 'resume_here',
    body: [
      'You are RESUMING a rotated session. Your recovered handoff and carried checklist are at the TOP of this message;',
      'the thread brief and batch above are unchanged context, NOT a signal to start over. Before anything else:',
      '1. Re-read your OWN thread spec section under `/context/specs/sections/` and the specific pointers your handoff',
      '   names (the commit SHA, the files by path). Do NOT re-read every spec — pull only what this next step needs.',
      '2. Do the SINGLE "Next safe action" from your handoff. One step, then reassess against the carried checklist.',
      '3. Continue — do NOT restart the batch, do NOT redo work already committed or staged, and do NOT re-ask or',
      '   re-derive anything the handoff already settles.',
    ].join('\n'),
  }),
);

/**
 * SOFT nudge steered into the LIVE builder turn once occupancy crosses the soft threshold. Carries the FULL
 * handoff schema (the builder reads THIS, not the tool description) so the handoff it authors is solid and
 * self-sufficient. If the builder keeps going, {@link ROTATION_REMINDER_NUDGE} re-fires every +delta of growth.
 */
export const ROTATION_SOFT_NUDGE = agentMessage(
  renderHarnessTag({
    tag: 'context_pressure',
    attrs: [['phase', 'soft']],
    body: [
      'Your context window is filling up. This is a system signal based on your ACTUAL live token usage — trust it',
      'even if it feels early. Get to a safe stopping point: finish only the step you are on and, if you are at a',
      'natural boundary, commit it. Do NOT start new large work.',
      '',
      'Then call `record_leg_handoff` with ONE `handoff` markdown string so a FRESH session can continue with zero',
      'loss. A good handoff is concrete — real paths, verbatim errors, one next step — under these headings:',
      '',
      ...HANDOFF_SCHEMA,
      '',
      'Write what a fresh session could NOT recover just by reading the tree. Omit a heading rather than pad it. After',
      'you call the tool, STOP and yield — your work-in-progress is safe on disk and the next session picks it up.',
    ].join('\n'),
  }),
);

/**
 * REMINDER nudge re-steered every +`reminderDeltaTokens` of growth AFTER the soft nudge, for as long as the
 * builder keeps working without handing off. Same ask, sharper — there is no hard stop and nothing forces the
 * rotation, so this is how a stubborn builder gets re-poked until it complies.
 */
export const ROTATION_REMINDER_NUDGE = agentMessage(
  renderHarnessTag({
    tag: 'context_pressure',
    attrs: [['phase', 'reminder']],
    body: [
      'You still owe a handoff and your context has grown further since the last signal — recall and reasoning are',
      'degrading. Nothing will force this for you: rotation happens ONLY when you call `record_leg_handoff`. Get to a',
      'safe stopping point NOW, then call `record_leg_handoff` with the structured handoff described earlier (scope &',
      'files by status; FAILED attempts with verbatim errors; committed-vs-WIP on-disk state + commit SHA; the single',
      'next safe action; open questions with options; pointers). Then yield. Do not start anything new.',
    ].join('\n'),
  }),
);

/** The one-line description the `record_leg_handoff` tool advertises. NOTE: the in-container Claude bridge shows
 *  a generic description, so the builder reads the schema from {@link ROTATION_SOFT_NUDGE}, not this — kept as a
 *  doc export + for any engine path that DOES surface tool descriptions. */
export const RECORD_LEG_HANDOFF_DESCRIPTION =
  'Hand off this build session to a fresh one when your context is full (you were nudged about context pressure). ' +
  'Pass a single `handoff` markdown string covering: scope & files changed by path+status; FAILED attempts WITH ' +
  'their verbatim errors; committed-vs-WIP on-disk state + commit SHA; decisions this session; verification ' +
  '(commands + exit codes + output tails); the single next safe action; open questions with options; and pointers ' +
  '(`/context/specs`). After calling this, STOP and yield — your WIP is on disk.';

/**
 * Compose the FRESH Leg's continuation seed — the hub-side factory for the driver's former inline join, so the
 * assembly (and its `agentMessage` mint) lives in the hub, not free-handed at the call site. Frames the builder's
 * OWN `record_leg_handoff` body — non-hub-authored text, so it crosses the seam via {@link fromExternal} — with
 * the hub-authored {@link ROTATION_PREAMBLE} (primacy slot) and, when present, the carried open-task checklist.
 * `carriedTasks` is the (possibly empty) `renderOpenLegTasks` block; an empty block is omitted. Byte-identical
 * to the prior `[ROTATION_PREAMBLE, handoff, ...tasks].join('\n\n')`.
 */
export function composeLegSeed(handoff: string, carriedTasks: AgentMessage): AgentMessage {
  return agentMessage(
    [ROTATION_PREAMBLE, fromExternal(handoff), ...(carriedTasks ? [carriedTasks] : [])].join('\n\n'),
  );
}

/**
 * Fold a rotation seed into the fresh Leg's turn task: seed (primacy slot) → base task → {@link ROTATION_RESUME_TAIL}
 * (recency slot, where LLM recall is highest). A non-rotated Leg (no seed) gets the bare base task unchanged.
 */
export function foldLegSeed(seed: AgentMessage | null, baseTask: AgentMessage): AgentMessage {
  return agentMessage(
    seed ? `${seed}\n\n---\n\n${baseTask}\n\n---\n\n${ROTATION_RESUME_TAIL}` : baseTask,
  );
}

/**
 * Fold a turn-kick's task: append the freshly-probed running-services block (hub prose from
 * `renderRunningServicesNote`) to the base task, THEN apply the {@link foldLegSeed} rotation fold. Appending
 * to `baseTask` (rather than after the seed fold) keeps {@link ROTATION_RESUME_TAIL} in the recency slot for a
 * rotated Leg. An empty services block leaves the base task unchanged. `seed` is the hub-composed seed read
 * back from the durable step row — brand-erased on that round-trip, so it re-crosses the seam via
 * {@link fromExternal}.
 */
export function foldLegTurn(
  seed: string | null,
  baseTask: AgentMessage,
  servicesBlock: string,
): AgentMessage {
  const withServices = agentMessage(servicesBlock ? `${baseTask}\n\n${servicesBlock}` : baseTask);
  return foldLegSeed(seed != null ? fromExternal(seed) : null, withServices);
}

/**
 * Strip the `<context_pressure …>` wrapper off a rotation nudge so the VISIBLE transcript row shows the clean
 * ask (the XML framing is engine-only; the operator sees prose). Trims the outer tag lines only. Lives in the
 * hub alongside the nudges it strips, so the mint stays inside prompt-kit.
 */
export function stripContextPressureTag(nudge: AgentMessage): AgentMessage {
  const stripped = nudge
    .replace(/^<context_pressure[^>]*>\s*/, '')
    .replace(/\s*<\/context_pressure>\s*$/, '')
    .trim();
  return agentMessage(stripped);
}

/** The `record_leg_handoff` tool's success reply — an explicit STOP so the model yields instead of continuing. */
export const RECORD_LEG_HANDOFF_STOP =
  'Handoff recorded and saved to /context/generated/handoffs/. Your session will now rotate: a fresh session ' +
  'continues from this handoff with your work-in-progress intact on disk. STOP here and end your turn now — do ' +
  'not take any further action.';
