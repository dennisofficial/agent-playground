import { tmpl } from '../_shared/tmpl';

/**
 * The loop-detection classifier prompt, as a `tmpl` constant. The guard renders this and feeds it to
 * the Haiku model as a HumanMessage (the same role the prior `PromptTemplate` produced). No literal
 * braces in the body, so the rendered text is byte-identical to the f-string version.
 */
export const GUARD_PROMPT = tmpl`You are watching ${'botName'}'s recent messages for a STUCK, no-progress loop.

${'botName'}'s last messages (oldest first):
${'window'}

Is ${'botName'} stuck — repeating the same statement, question, or action with no new progress?

Be CONSERVATIVE. Do NOT flag:
- Distinct sequential steps (even on the same topic)
- Alternating between two clearly different actions
- A back-and-forth where each reply adds genuinely new information
- A bot that said something once and then moved on

DO flag ONLY when the same conclusion, status, or action is repeated ≥ 2 times with nothing
new added — e.g., "still checking…" stalls, identical agreement strings, or the same
unanswered question re-asked verbatim.`;
