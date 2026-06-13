/**
 * Per-role prompt templates — the task prompt a worker run is opened with, as a PURE FUNCTION of
 * typed inputs (RunnableSequence-style). These feed the per-run `task` / one-shot `systemPrompt`,
 * NOT the byte-stable cached chat prompt (`persona.service.ts`), so live interpolation is safe here.
 *
 * An employee overrides any role's template in its config (`roles.<role>.prompt`); unset falls back
 * to the defaults below. The PLAN template is what makes `plan_md` an enriched handoff: it asks the
 * engine to emit structured sections (Files to touch · Constraints/Gotchas · Verify commands) so the
 * execute session can be seeded from the plan alone (Option B — the distilled findings travel
 * forward, the investigation noise stays behind).
 */

/** Inputs each role's template is rendered with. */
export interface PlanPromptInput {
  /** The ticket / opening task being planned. */
  ticket: string;
  /** Any extra context the planner should carry in (optional). */
  context?: string;
}
export interface ExecutePromptInput {
  /** The ticket the execute session works. */
  ticket: string;
  /** The approved, enriched plan (`plan_md`) — the handoff. */
  plan: string;
}
export interface ReviewPromptInput {
  /** What the work is ultimately for (usually the ticket title/goal). */
  goal: string;
  /** The ticket / task the plan answers. */
  ticket: string;
  /** The plan text under review. */
  plan: string;
}

export type PlanPromptTemplate = (input: PlanPromptInput) => string;
export type ExecutePromptTemplate = (input: ExecutePromptInput) => string;
export type ReviewPromptTemplate = (input: ReviewPromptInput) => string;

export const DEFAULT_PLAN_PROMPT: PlanPromptTemplate = ({ ticket, context }) =>
  `Plan this work — investigate the codebase first, then produce a concrete plan.\n\n` +
  `TICKET:\n${ticket}\n` +
  (context ? `\nCONTEXT:\n${context}\n` : '') +
  `\nProduce a plan that a SEPARATE execute session can run from this text alone (it will NOT have ` +
  `your investigation context). Structure it with these sections:\n` +
  `- **Summary** — what's being changed and why, in a few lines.\n` +
  `- **Files to touch** — the specific files/areas, each with what changes there.\n` +
  `- **Constraints & gotchas** — anything you discovered that the executor must respect ` +
  `(invariants, patterns to match, traps).\n` +
  `- **Steps** — the ordered implementation steps.\n` +
  `- **Verify** — the exact commands / checks that prove it works (tests, typecheck, build).`;

export const DEFAULT_EXECUTE_PROMPT: ExecutePromptTemplate = ({ ticket, plan }) =>
  `Execute this approved plan. It was reviewed and approved — follow it; deviate only where it's ` +
  `clearly wrong, and say so in your report if you do.\n\n` +
  `TICKET:\n${ticket}\n\nAPPROVED PLAN:\n${plan}`;

export const DEFAULT_REVIEW_PROMPT: ReviewPromptTemplate = ({
  goal,
  ticket,
  plan,
}) =>
  `You are a review agent. Adversarially review the plan below — your job is to find what's wrong, ` +
  `not to praise it. Read the relevant code to ground your critique (you are read-only).\n\n` +
  `GOAL: ${goal}\n\nTICKET:\n${ticket}\n\nPLAN UNDER REVIEW:\n${plan}\n\n` +
  `Challenge it: missing steps, wrong assumptions, files it forgot, ordering/dependency risks, and ` +
  `where it fails against how this codebase actually works. If the plan is sound, say so plainly and ` +
  `briefly. Return a short, specific list of concrete objections (or "no blocking issues").`;
