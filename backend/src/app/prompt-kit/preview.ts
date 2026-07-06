/**
 * prompt-kit / preview — the DEV-ONLY catalog for the `GET /test/prompts` preview endpoint + `dump-prompts`.
 *
 * Every system prompt is assembled via `renderAgentPrompt(agent, ctx)`; this maps a stable preview `id` to its
 * agent + a representative context, so the preview renders EXACTLY what production sends. (Replaces the former
 * `registry.ts` — there is only one assembly path now.)
 */
import { Agent } from './agent';
import type { JobKind } from '../domain';
import type { PromptCtx } from './prompt-ctx';
import { renderAgentPrompt } from './assemble';

export interface AgentPromptInfo {
  /** Stable preview id (kept close to the old registry ids so `/test/prompts/<id>` URLs still resolve). */
  id: string;
  agent: Agent;
  /** Where this prompt is sent from. */
  note: string;
  /** The representative context (a job kind for the job-kind-composed personas). */
  ctx: PromptCtx;
}

export const AGENT_PROMPTS: AgentPromptInfo[] = [
  { id: 'brain', agent: Agent.ATLAS_MAIN, note: 'job brain turn', ctx: { jobKind: 'feature' } },
  { id: 'brain-onboarding', agent: Agent.ATLAS_MAIN, note: 'job brain — onboarding', ctx: { jobKind: 'onboarding' } },
  { id: 'worker-orchestrate', agent: Agent.WORKER, note: 'build thread orchestrator', ctx: { jobKind: 'feature' } },
  { id: 'ship-pr-review', agent: Agent.PR_REVIEW, note: 'ship PR-review orchestrator', ctx: { jobKind: 'feature' } },
  { id: 'ship-master-review', agent: Agent.MASTER_REVIEW, note: 'ship Codex master review', ctx: {} },
  { id: 'ship-open-pr', agent: Agent.SHIP_OPEN_PR, note: 'ship in-sandbox open-PR turn', ctx: {} },
  { id: 'autofix-review', agent: Agent.AUTOFIX_REVIEW, note: 'auto-fix review pass', ctx: {} },
  { id: 'autofix-fix', agent: Agent.AUTOFIX_FIX, note: 'auto-fix fix turn', ctx: {} },
  { id: 'subagent-explore', agent: Agent.EXPLORE, note: 'engine explore subagent', ctx: {} },
  { id: 'subagent-docs', agent: Agent.DOCS, note: 'engine docs subagent', ctx: {} },
  { id: 'subagent-review', agent: Agent.REVIEW_AGENT, note: 'engine review subagent', ctx: {} },
  { id: 'subagent-debug', agent: Agent.DEBUG, note: 'engine debug subagent', ctx: {} },
  { id: 'subagent-test', agent: Agent.TEST, note: 'engine test subagent', ctx: {} },
  { id: 'subagent-validate', agent: Agent.VALIDATE, note: 'engine live-validation + evidence subagent', ctx: {} },
  { id: 'subagent-writer', agent: Agent.FAN_OUT, note: 'engine implement/implement-deep writer', ctx: {} },
  { id: 'meta-plan-review', agent: Agent.META_PLAN_REVIEW, note: 'plan-review Codex chain', ctx: {} },
  { id: 'meta-decision-classifier', agent: Agent.META_CLASSIFIER, note: 'decision-gate classifier chain', ctx: {} },
  { id: 'meta-job-titler', agent: Agent.META_TITLER, note: 'job-title chain', ctx: {} },
];

/** The previewable prompts (id + agent + note) for `GET /test/prompts`. */
export function listAgentPrompts(): Array<{ id: string; agent: string; note: string }> {
  return AGENT_PROMPTS.map(({ id, agent, note }) => ({ id, agent: String(agent), note }));
}

/** Whether `id` is a previewable prompt. */
export function hasAgentPrompt(id: string): boolean {
  return AGENT_PROMPTS.some((a) => a.id === id);
}

/** Render a previewable prompt by id, optionally overriding the job kind. Returns null for an unknown id. */
export function renderPreview(id: string, jobKindOverride?: JobKind | null): string | null {
  const entry = AGENT_PROMPTS.find((a) => a.id === id);
  if (!entry) return null;
  const ctx = jobKindOverride !== undefined ? { ...entry.ctx, jobKind: jobKindOverride } : entry.ctx;
  return renderAgentPrompt(entry.agent, ctx);
}
