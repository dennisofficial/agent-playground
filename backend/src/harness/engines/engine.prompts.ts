import { tmpl } from '../_shared/tmpl';

/**
 * Per-role prompt templates — the task prompt a worker run is opened with, plus the Claude engine's
 * tool-denial messages. These feed the per-run `task` / one-shot `systemPrompt`, NOT the byte-stable
 * cached chat prompt (`persona.prompts.ts`), so live interpolation is safe here.
 *
 * The PLAN template is what makes `plan_md` an enriched handoff: it asks the engine to emit structured
 * sections (Files to touch · Constraints/Gotchas · Verify commands) so the execute session can be seeded
 * from the plan alone (Option B — the distilled findings travel forward, the investigation noise stays
 * behind). Built with the house `tmpl` helper, not inline string concatenation.
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

/** The reasons an employee opens an investigation — shapes the prompt's EMPHASIS, not the model. */
export const INVESTIGATE_INTENTS = ['trace', 'debug', 'review'] as const;
export type InvestigateIntent = (typeof INVESTIGATE_INTENTS)[number];
export interface InvestigatePromptInput {
  /** The code-grounded question to answer. */
  question: string;
  /** Why this investigation is being run — selects an emphasis line (optional). */
  intent?: InvestigateIntent;
}

export type PlanPromptTemplate = (input: PlanPromptInput) => string;
export type ExecutePromptTemplate = (input: ExecutePromptInput) => string;
export type ReviewPromptTemplate = (input: ReviewPromptInput) => string;
export type InvestigatePromptTemplate = (
  input: InvestigatePromptInput,
) => string;

// PLAN has an optional CONTEXT section, so it composes three pieces (logic in code, text in templates).
const PLAN_HEAD = tmpl`You are in PLAN MODE. Investigate the codebase READ-ONLY — read and search as much as you need to understand the work, but do NOT modify anything, run write/build commands, or start implementing. Your one deliverable this turn is the plan itself.

TICKET:
${'ticket'}
`;
const PLAN_CONTEXT = tmpl`
CONTEXT:
${'context'}
`;
const PLAN_TAIL = `
When you understand the work, write a concrete plan that a SEPARATE execute session could carry out from this text ALONE (it will NOT have your investigation context), then STOP and end your turn — the plan goes to review and approval before any code is written; do not implement it now. Structure the plan with these exact sections:
- **Summary** — what's being changed and why, in a few lines.
- **Diagrams** — 1–3 Mermaid diagrams (each in its own \`\`\`mermaid fenced block) that make the plan graspable at a glance, because a human reviewer should get the shape of the change from the pictures, not a wall of prose. Good choices: an architecture/component sketch of what touches what, a flow or sequence diagram of how it works at runtime, and — when the change spans several files/modules — a file-impact sketch. Keep each small and high-signal; skip any diagram that wouldn't add real understanding. Use valid Mermaid syntax (e.g. \`graph TD\`, \`sequenceDiagram\`, \`flowchart LR\`).
- **Files to touch** — the specific files/areas, each with what changes there.
- **Constraints & gotchas** — anything you discovered that the executor must respect (invariants, patterns to match, traps).
- **Steps** — the ordered implementation steps.
- **Verify** — the exact commands / checks that prove it works (tests, typecheck, build).`;

export const DEFAULT_PLAN_PROMPT: PlanPromptTemplate = ({ ticket, context }) =>
  PLAN_HEAD({ ticket }) +
  (context ? PLAN_CONTEXT({ context }) : '') +
  PLAN_TAIL;

export const DEFAULT_EXECUTE_PROMPT: ExecutePromptTemplate = tmpl`Execute this approved plan. It was reviewed and approved — follow it; deviate only where it's clearly wrong, and say so in your report if you do.

TICKET:
${'ticket'}

APPROVED PLAN:
${'plan'}`;

export const DEFAULT_REVIEW_PROMPT: ReviewPromptTemplate = tmpl`You are a review agent. Adversarially review the plan below — your job is to find what's wrong, not to praise it. Read the relevant code to ground your critique (you are read-only).

GOAL: ${'goal'}

TICKET:
${'ticket'}

PLAN UNDER REVIEW:
${'plan'}

Challenge it: missing steps, wrong assumptions, files it forgot, ordering/dependency risks, and where it fails against how this codebase actually works. If the plan is sound, say so plainly and briefly. Return a short, specific list of concrete objections (or "no blocking issues").`;

// INVESTIGATE composes a head + optional intent emphasis + a REQUIRED epistemic-output tail (text in
// templates, the optional piece in code — same shape as PLAN). The tail is the load-bearing part: it
// forces the worker to self-report confidence and what it couldn't verify, so a reader knows when an
// answer is on soft ground (an answer that's confidently wrong is worse than no session).
const INVESTIGATE_HEAD = tmpl`Answer this question by reading the ACTUAL codebase, then report back. This turn is READ-ONLY — do not modify, plan, or propose changes; just find the answer and give it concisely, citing the relevant file:line references for every claim. Trust the real code over your prior assumptions or any docs: if something is described one way but the code differs, the code wins, and if you cannot find something, say so plainly instead of guessing.

QUESTION:
${'question'}
`;
const INVESTIGATE_EMPHASIS: Record<InvestigateIntent, string> = {
  trace:
    'Walk the exact path end to end and name every hop, with a file:line at each step.',
  debug:
    "You're chasing unexpected behavior: hunt for the discrepancy, edge case, or wrong assumption — and first check whether the premise is even true (the thing described may not exist, or may work differently than stated).",
  review:
    'Evaluate the design itself — trade-offs, risks, and where it could fail — not just describe what the code does.',
};
const INVESTIGATE_TAIL = `
End your report with these two lines, exactly:
Confidence: high | medium | low — <one phrase on why>
Couldn't verify: <the specific things you could not confirm from the code, or "none">`;

export const DEFAULT_INVESTIGATE_PROMPT: InvestigatePromptTemplate = ({
  question,
  intent,
}) =>
  INVESTIGATE_HEAD({ question }) +
  (intent ? `\nFOCUS: ${INVESTIGATE_EMPHASIS[intent]}\n` : '') +
  INVESTIGATE_TAIL;

/**
 * The Claude engine's tool-denial messages (returned from `canUseTool`). Static strings stay constants;
 * the three that interpolate runtime detail are small renderers. Kept here so all engine prompt text
 * lives in one place rather than inline in `claude.engine.ts`.
 */
export const CLAUDE_DENIALS = {
  questionsRelayed:
    'Your questions have been relayed to your team — this is the expected flow, not an error. Do NOT re-ask or rephrase them, do not answer them yourself, and do not call AskUserQuestion again. End your turn NOW with one line saying you are waiting on answers; they arrive as your next message.',
  noQuestions:
    'No interactive questions on this turn — carry the work as far as you can and put any open questions in your end-of-turn report.',
  planRecorded:
    'Plan received and recorded — do not execute anything. End your turn now; your plan is being reviewed.',
  readOnlyWrite:
    'This is a read-only turn — describe what you found instead of writing it.',
  bashRefused: (reason: string) => `Refused: ${reason}.`,
  readOnlyBash: (write: string) => `This is a read-only turn — ${write}.`,
  escapesRoot: (path: string) =>
    `Refused: "${path}" escapes the project directory.`,
} as const;
