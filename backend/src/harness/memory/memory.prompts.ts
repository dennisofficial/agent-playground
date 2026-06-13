import { tmpl } from '../_shared/tmpl';

/**
 * The memory-module classifier prompts (post-turn reconcile + dedup judge), as `tmpl` constants. The
 * services render these and feed the result to the extract model as a HumanMessage — the same message
 * role the prior `PromptTemplate` produced (its `StringPromptValue` converts to a HumanMessage). Slots
 * use `${'var'}`; no literal braces in the bodies, so the rendered text is byte-identical to the f-string.
 */

export const MEMORY_PROMPT = tmpl`You are ${'botName'}, the team's ${'botRole'}, reconciling your MEMORY after a turn in
${'room'}. People and their ids: ${'people'}.

What you currently know (existing facts, each with its #id):
${'currentFacts'}

This turn:
${'transcript'}

Decide what should change (be conservative — most turns change nothing). Reference existing facts ONLY
by the #id shown above — never invent an id:
- add: NEW durable facts worth keeping long-term — a stable preference, decision, role, or project fact.
  ONLY from what the HUMANS said (not teammates' replies). NOT chatter, greetings, questions, task
  instructions, or coding-style. State each as the BARE atomic claim ONLY — the decision/preference
  itself, with no interpretation, consequences, rationale, or "what this means for X" elaboration (store
  "Backend standardizes on PostgreSQL", NOT a paragraph about migrations and future work); elaborated
  facts pile up as near-duplicates that never dedup. Set "tier": project = DEFAULT for work facts (about THIS project — its
  repo, stack, goals, or a decision made here); team = roles, who does what, and the boss's STANDING
  preferences that hold across every project; private = personal/sensitive; bot = only you. Set "authorId"
  = the human who said it. Do NOT re-add something already above — even if worded differently. If the new
  fact CONTRADICTS or replaces an existing one, set "supersedes" to that fact's #id (so the stale one is
  overwritten, not kept alongside it).${'tierNote'}
- update: an existing fact (by #id) whose wording/value CHANGED — give "id" and "newFact".
- delete: an existing fact (by #id) now contradicted or no longer true — give "id".

Return empty arrays when nothing changed.`;

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
