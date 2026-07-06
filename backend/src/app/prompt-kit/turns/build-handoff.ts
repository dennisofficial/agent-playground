/**
 * prompt-kit / turns / build-handoff — the LEG-ROTATION handoff prompts (the builder analog of the brain's
 * compaction `COMPACTION_SYSTEM` / `COMPACTION_INSTRUCTION` / `CONTINUATION_PREAMBLE`). One build Thread now
 * spans many sequential engine sessions ("Legs"); when the anchor step's live session fills past the SOFT/HARD
 * occupancy thresholds we ROTATE: author a structured handoff, abandon the fat session, and seed a FRESH one
 * with that handoff (the WIP survives on disk in the shared worktree). See the plan
 * `~/.claude/plans/context-rot-is-real-immutable-sedgewick.md` (Part B4).
 *
 * There are two ways the handoff gets written:
 *  • self-authored — the live builder calls the `record_leg_handoff` host tool (steered toward it by the
 *    SOFT/HARD nudges below) and yields. The clean, KV-cache-preserving path.
 *  • fallback — the builder ignored the nudges and ran to `result`; the host then fires a READ-ONLY handoff
 *    turn (`ROTATION_SYSTEM` + `ROTATION_INSTRUCTION`) against the fat session to author one. Mirrors the
 *    brain's `runCompaction`.
 *
 * Either way the handoff is seeded into the next Leg's task wrapped in {@link ROTATION_PREAMBLE} (the analog of
 * `CONTINUATION_PREAMBLE`). Unlike the planning brain, a builder's durable state is the WORKTREE (not
 * `/context/specs`) — so the schema leans on "what's on disk, by path+status" and KEEPS failed attempts with
 * their verbatim errors (pruning them makes the next Leg repeat them — Manus).
 */

/** The structured handoff schema, shared by the self-authored tool and the fallback turn. Nine headings. */
const HANDOFF_SCHEMA = [
  '1. Scope & files changed — each file you touched, by path, with a one-line status: done / WIP / not-started.',
  '2. Attempts & FAILED attempts — every approach you tried that did NOT work, WITH the verbatim error text.',
  '   Do NOT drop errors: the fresh Leg needs them so it does not repeat a dead end.',
  '3. Open issues / blockers — what is unresolved right now.',
  '4. Decisions this Leg — choices you made that are not already written into `.atlas/decisions/`.',
  '5. Verification — commands you ran, their exit codes, and the tail of their output (evidence, not claims).',
  '6. Current state — exactly what is on disk NOW: what is committed vs uncommitted WIP in the worktree.',
  '7. Next safe action — the single concrete next step the fresh Leg should take.',
  '8. Open questions, each with options — so the next Leg proceeds without re-deriving or re-asking.',
  '9. Pointers — the durable artifacts to re-read: `/context/specs`, `.atlas/decisions/`, the current commit',
  '   SHA, and `get_pipeline_state`. Reference them by path; do not re-transcribe them.',
];

/**
 * System prompt for the READ-ONLY fallback handoff turn (mirrors `COMPACTION_SYSTEM`). Focuses the model on
 * producing ONLY the handoff — no edits, no tools, no questions — since the fat session is being abandoned.
 */
export const ROTATION_SYSTEM = [
  'You are handing off your own long-running build session so a FRESH session can continue it with no loss of',
  'important context. Your context window has filled to the point where quality degrades ("context rot"). Your',
  'ONLY task this turn is to write a handoff for your successor. Do NOT edit files, run commands, call any tool,',
  'or ask any question — your work-in-progress is already saved on disk in the worktree. Output ONLY the handoff.',
].join('\n');

/**
 * The fallback turn's task — the handoff schema, adapted to "point at durable worktree state, keep the errors".
 * The self-authored path delivers the same schema via the nudges + the `record_leg_handoff` tool description.
 */
export const ROTATION_INSTRUCTION = [
  'Write a HANDOFF for a fresh continuation of THIS build session. Your uncommitted work-in-progress is already',
  'on disk in the worktree — the fresh session inherits it. The handoff\'s job is to tell your successor what is',
  'half-done and how to continue WITHOUT restarting the batch. Capture what a fresh session could not recover',
  'just by reading the tree, under these headings:',
  '',
  ...HANDOFF_SCHEMA,
  '',
  'Be concrete and factual — reference files and commands, not intentions. Omit a heading rather than pad it.',
  'Output ONLY the handoff — no preamble.',
].join('\n');

/**
 * Prepended to the handoff when it seeds the FRESH Leg (folded into the next batch task by the driver). Frames
 * the handoff as recovered memory and tells the session to CONTINUE, not restart. Analog of `CONTINUATION_PREAMBLE`.
 */
export const ROTATION_PREAMBLE = [
  '<session_rotated>',
  'Your previous build session filled its context window and was rotated to keep you sharp. Its handoff is below.',
  'Treat it as your OWN recovered memory. Your work-in-progress from that session is ALREADY ON DISK in this',
  'worktree — do NOT restart the batch, do NOT redo work that is already committed or staged, and do NOT re-ask',
  'or re-derive anything the handoff already settles. Re-read the durable artifacts it points to as needed',
  '(`/context/specs`, `.atlas/decisions/`, `get_pipeline_state`), then continue from its "Next safe action".',
  '</session_rotated>',
].join('\n');

/**
 * SOFT nudge (~150k) steered into the LIVE builder turn: wrap up the current phase at a natural boundary, then
 * author the handoff and yield. Rotating at the SOFT boundary preserves the KV-cache (vs the HARD net).
 */
export const ROTATION_SOFT_NUDGE = [
  '<context_pressure phase="soft">',
  'Your context window is getting high (~150k tokens). Finish only the phase you are on and, if you are at a',
  'natural boundary, commit it. Then call `record_leg_handoff` with a structured handoff for a fresh session',
  'and stop — do NOT start new large work. If you are mid-edit, get to a safe stopping point first.',
  '</context_pressure>',
].join('\n');

/**
 * HARD nudge (~200k) steered into the LIVE builder turn: stop after the current action and author the handoff
 * NOW. If the builder still ignores this and runs to `result`, the host fires the read-only fallback turn.
 */
export const ROTATION_HARD_NUDGE = [
  '<context_pressure phase="hard">',
  'You are past 200k tokens and entering context-rot territory — your reasoning and recall are degrading. Stop',
  'after the current action. Call `record_leg_handoff` NOW with a structured handoff (scope & files by status,',
  'FAILED attempts with their verbatim errors, current on-disk state, next safe action), then yield. Do not',
  'start anything new.',
  '</context_pressure>',
].join('\n');

/** The one-line description the `record_leg_handoff` tool advertises (the handoff schema, condensed). */
export const RECORD_LEG_HANDOFF_DESCRIPTION =
  'Hand off this build session to a fresh one when your context is full (you were nudged about context pressure). ' +
  'Pass a single `handoff` markdown string covering: scope & files changed by path+status; FAILED attempts WITH ' +
  'their verbatim errors; open issues; decisions this session; verification (commands + exit codes + output tails); ' +
  'current on-disk state (committed vs WIP); the single next safe action; open questions with options; and pointers ' +
  '(`/context/specs`, `.atlas/decisions/`, commit SHA). After calling this, STOP and yield — your WIP is on disk.';

/** The `record_leg_handoff` tool's success reply — an explicit STOP so the model yields instead of continuing. */
export const RECORD_LEG_HANDOFF_STOP =
  'Handoff recorded. Your session will now rotate: a fresh session continues from this handoff with your ' +
  'work-in-progress intact on disk. STOP here and end your turn now — do not take any further action.';
