/**
 * prompt-kit / registry — id → composed-prompt thunk, for the DEV-ONLY preview endpoint
 * (`GET /test/prompts`, `GET /test/prompts/:id`). Keeping every prompt reachable through one registry
 * means the preview renders EXACTLY what production composes, for any job kind.
 *
 * Two shapes of entry:
 *   - COMPOSED — production wraps the body with `buildSystemPrompt({ audience, jobKind, body })` at the
 *     call site; the entry re-does the SAME composition so preview is faithful (job kind comes from ctx).
 *   - RAW — production passes the body string straight to the engine (no composer); the entry returns it
 *     verbatim and ignores the job kind.
 */
import type { JobKind } from '../domain';
import {
  BRAIN_LEDGER_PROMOTION_PROMPT,
  BRAIN_ONBOARDING_SYSTEM_PROMPT,
  BRAIN_SYSTEM_PROMPT,
} from './bodies/brain.body';
import {
  BATCH_EXECUTE_SYSTEM,
  ORCHESTRATE_EXECUTE_SYSTEM,
  STEP_EXECUTE_SYSTEM,
  THREAD_PLAN_SYSTEM,
} from './bodies/worker.body';
import { MASTER_REVIEW_SYSTEM_PROMPT, PR_REVIEW_SYSTEM_PROMPT } from './bodies/ship.body';
import { EXTRACT_SYSTEM, PLAN_SYSTEM, REVIEW_SYSTEM } from './bodies/planner.body';
import { FIX_SYSTEM_PROMPT, REVIEW_SYSTEM_PROMPT } from './bodies/autofix.body';
import {
  DEBUG_SUBAGENT_PROMPT,
  DOCS_SUBAGENT_PROMPT,
  EXPLORE_SUBAGENT_PROMPT,
  REVIEW_SUBAGENT_PROMPT,
  TEST_SUBAGENT_PROMPT,
  WRITER_PROMPT,
} from './bodies/subagents.body';
import {
  DECISION_CLASSIFIER_SYSTEM,
  JOB_TITLER_SYSTEM,
  PLAN_REVIEW_SYSTEM,
} from './bodies/meta.body';
import { buildSystemPrompt, type PromptAudience } from './compose';

export interface PromptRenderCtx {
  jobKind?: JobKind | null;
}

export interface PromptRegistryEntry {
  id: string;
  /** How this prompt is assembled: a composed audience (layers + job-kind), or 'raw' (body verbatim). */
  audience: PromptAudience | 'raw';
  /** Short note on where this prompt is sent from. */
  usedBy: string;
  render: (ctx: PromptRenderCtx) => string;
}

/** COMPOSED entry — the body is assembled by `buildSystemPrompt` (layers + job-kind). */
function composed(
  id: string,
  audience: PromptAudience,
  usedBy: string,
  body: string,
): PromptRegistryEntry {
  return {
    id,
    audience,
    usedBy,
    render: (ctx) => buildSystemPrompt({ audience, jobKind: ctx.jobKind, body }),
  };
}

/** RAW entry — production sends `body` verbatim (no composer); job kind is ignored. */
function raw(id: string, usedBy: string, body: string): PromptRegistryEntry {
  return { id, audience: 'raw', usedBy, render: () => body };
}

const ENTRIES: PromptRegistryEntry[] = [
  // The conversational brain (composed with the brain layer + job kind at the call site).
  composed('brain', 'brain', 'AgentSessionManager brain turn', BRAIN_SYSTEM_PROMPT),
  composed(
    'brain-onboarding',
    'brain',
    'AgentSessionManager onboarding turn',
    BRAIN_ONBOARDING_SYSTEM_PROMPT,
  ),
  // Build/execute turns (composed with the worker layer — validate-by-running + spike-first + job kind).
  composed('worker-orchestrate', 'worker', 'ThreadDriver execute (orchestrate)', ORCHESTRATE_EXECUTE_SYSTEM),
  composed('worker-step', 'worker', 'ThreadDriver execute (single step)', STEP_EXECUTE_SYSTEM),
  composed('worker-batch', 'worker', 'ThreadDriver execute (batch)', BATCH_EXECUTE_SYSTEM),
  // Thread planning turn (composed with the planner layer — baseline-first + spike-first + job kind).
  composed('planner-thread-plan', 'planner', 'ThreadDriver plan turn', THREAD_PLAN_SYSTEM),
  // Ship-time PR review orchestrator (composed with the ship layer — validate-by-running + job kind).
  composed('ship-pr-review', 'ship', 'BuildShipService PR review', PR_REVIEW_SYSTEM_PROMPT),

  // ── RAW: sent verbatim (no composer wrap in production) ──
  raw('ship-master-review', 'BuildShipService master review (Codex)', MASTER_REVIEW_SYSTEM_PROMPT),
  raw('planner-structured-plan', 'PlannerChains.planThread (LLM)', PLAN_SYSTEM),
  raw('planner-structured-review', 'PlannerChains.reviewPlan (LLM)', REVIEW_SYSTEM),
  raw('planner-structured-extract', 'PlannerChains.extractDecisions (LLM)', EXTRACT_SYSTEM),
  raw('autofix-review', 'AutoFix review pass', REVIEW_SYSTEM_PROMPT),
  raw('autofix-fix', 'AutoFix fix turn', FIX_SYSTEM_PROMPT),
  raw('subagent-writer', 'engine implement/implement-deep writer subagents', WRITER_PROMPT),
  raw('subagent-explore', 'engine explore subagent', EXPLORE_SUBAGENT_PROMPT),
  raw('subagent-docs', 'engine docs subagent', DOCS_SUBAGENT_PROMPT),
  raw('subagent-review', 'engine review subagent', REVIEW_SUBAGENT_PROMPT),
  raw('subagent-debug', 'engine debug subagent', DEBUG_SUBAGENT_PROMPT),
  raw('subagent-test', 'engine test subagent', TEST_SUBAGENT_PROMPT),
  raw('meta-plan-review', 'plan-review.service Codex review', PLAN_REVIEW_SYSTEM),
  raw('meta-decision-classifier', 'decision-gate classifier (LLM)', DECISION_CLASSIFIER_SYSTEM),
  raw('meta-job-titler', 'titling job-title chain (LLM)', JOB_TITLER_SYSTEM),
  raw('brain-ledger-promotion', 'AgentSessionManager promote_decisions', BRAIN_LEDGER_PROMOTION_PROMPT),
];

/** All previewable prompts, keyed by stable id. */
export const PROMPT_REGISTRY: Record<string, PromptRegistryEntry> = Object.fromEntries(
  ENTRIES.map((e) => [e.id, e]),
);

export function listPromptIds(): Array<{ id: string; audience: string; usedBy: string }> {
  return ENTRIES.map((e) => ({ id: e.id, audience: e.audience, usedBy: e.usedBy }));
}

/**
 * THE single accessor: build a complete system prompt by id. This is the ONE door every production call
 * site goes through — there is no appending/prepending or `buildSystemPrompt` at the call site; the
 * registry entry owns the audience + body + composition, so what production sends is exactly what the
 * preview endpoint renders. Throws (fail-fast) on an unknown id — a wrong id is a programming error.
 */
export function renderSystemPrompt(id: string, ctx: PromptRenderCtx = {}): string {
  const entry = PROMPT_REGISTRY[id];
  if (!entry) {
    throw new Error(
      `Unknown system prompt id '${id}'. Known ids: ${Object.keys(PROMPT_REGISTRY).sort().join(', ')}`,
    );
  }
  return entry.render(ctx);
}

/** Whether an id is a registered system prompt (for the preview endpoint's soft 404). */
export function hasSystemPrompt(id: string): boolean {
  return id in PROMPT_REGISTRY;
}
