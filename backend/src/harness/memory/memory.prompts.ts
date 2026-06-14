import { tmpl } from '../_shared/tmpl';

/**
 * The memory-module classifier prompts (post-turn reconcile + dedup judge), as `tmpl` constants. The
 * services render these and feed the result to the extract model as a HumanMessage — the same message
 * role the prior `PromptTemplate` produced (its `StringPromptValue` converts to a HumanMessage). Slots
 * use `${'var'}`; no literal braces in the bodies, so the rendered text is byte-identical to the f-string.
 */

// Narrowed to exactly three qualifying classes (Phase 2). Everything else is filtered out:
// greetings, questions, task instructions, coding-style notes, inferred preferences, generic
// project/stack facts not framed as a decision, status narration, anticipatory chatter,
// routine "I'll do X later" — none of these qualify.
export const MEMORY_PROMPT = tmpl`You are ${'botName'}, the team's ${'botRole'}, reviewing a turn in ${'room'} for memory suggestions.
People and their ids: ${'people'}.

What you currently know (existing facts, each with its #id):
${'currentFacts'}

This turn:
${'transcript'}

Surface a memory suggestion ONLY when the turn contains one of exactly THREE qualifying classes.
Filter out EVERYTHING else — greetings, questions, task instructions, coding-style notes, roles,
inferred preferences, generic project/stack facts not framed as a decision, status narration,
anticipatory chatter ("ready to execute when X closes"), routine "I'll do X later" commitments
(those go to reminders, not memory).

THREE qualifying classes (with example triggers):
1. EXPLICIT CORRECTION — the human corrected something previously said or something in stored memory.
   Example: "Actually, we use MySQL now, not Postgres" when Postgres appears in the known facts.
   kind = "correction" → suggest update or forget on the contradicted #id.

2. STATED DECISION — a named outcome with clear parties: "We've decided X", "We're going with Y",
   "The team has agreed to Z". Must be explicitly framed as a decision, not inferred from context.
   kind = "decision" → suggest add with a bare atomic statement of the outcome.

3. EXPLICIT USER PREFERENCE — directly and clearly stated: "I prefer X", "I always want Y",
   "please always do Z", "I never want…". Must be stated, not inferred from behavior or choices.
   kind = "preference" → suggest add.

If this turn contains NONE of these three classes, return empty arrays and say "nothing qualifies"
in the reasoning field. Most turns contain nothing — returning [] is the correct and expected answer.

For add suggestions:
- Bare atomic claim ONLY — the decision/preference itself, no elaboration, consequences, or rationale.
  ("Backend standardizes on PostgreSQL" — NOT a paragraph about migrations and future work.)
- tier: project = work fact about THIS project (default); team = standing preferences / roles that
  hold across every project; private = personal/sensitive; bot = only you.
- authorId = the human who stated it.
- supersedes = #id of an existing fact this contradicts (so the stale one isn't kept alongside it).${'tierNote'}

Reference existing facts by their shown #id ONLY — never invent an id.
Return empty arrays when nothing qualifies.`;

export const TASK_PROMPT = tmpl`You are ${'botName'}, keeping the team's personal REMINDERS straight after a turn in
${'room'}. People and their ids: ${'people'}.

Open reminders right now (with #ids — yours, and ones you raised for others):
${'openTasks'}

This turn:
${'transcript'}

A reminder is a concrete commitment to FUTURE work, captured so it isn't lost in a long, summarized work
session — ESPECIALLY a deferred one ("got it, I'll do that after I finish this", "I'll send the spec
later", "once the API's up I'll wire the hooks"). Decide (be conservative — most turns add nothing):
${'projectNote'}- add: a NEW such commitment made THIS turn. ${'ownershipNote'}Do NOT re-add work already a reminder
  above — even reworded; one open reminder per piece of work, never a second copy. Do NOT capture status
  narration about work already underway ("publishing now", "still running", "I'll push once X lands" about
  an effort already in motion) — a reminder is for work that would otherwise be FORGOTTEN, not a play-by-play.
  Do NOT capture anything this same turn also reports finished, and NOT chit-chat, finished replies, or
  vague non-commitments.
- complete: an open reminder (by #id above) this turn shows is finished.
- drop: an open reminder (by #id above) no longer relevant.

Return empty arrays when nothing changed.`;

export const JUDGE_PROMPT = tmpl`Two short facts from a team's long-term memory. Are they the SAME underlying fact —
the same claim about the same thing, just possibly worded differently? Answer false if they differ in
meaning in any material way, including opposites ("prefers X" vs "dislikes X") or a difference in
specifics that actually matters.

Existing: ${'existing'}
New: ${'candidate'}`;
