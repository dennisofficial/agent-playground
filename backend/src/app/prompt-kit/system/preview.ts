/**
 * prompt-kit / preview — the DEV-ONLY catalog for the `GET /test/prompts` preview endpoint + `dump-prompts`.
 *
 * Every system prompt is assembled via `renderAgentPrompt(agent, ctx)`; this maps a stable preview `id` to its
 * agent + a representative context, so the preview renders EXACTLY what production sends. (Replaces the former
 * `registry.ts` — there is only one assembly path now.)
 */
import { Agent } from './agent';
import type { JobKind } from '../../domain';
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

/** Representative multi-line standing operator/org instructions (the `brain-org-instructions` variant). */
const SAMPLE_ORG_INSTRUCTIONS = [
  'Prefer pnpm over npm/yarn across every repo.',
  'Always open PRs against `main`, never `master`.',
  'Tag Dennis for review on anything touching billing.',
].join('\n');

/** Representative repo house-style body (shared by the `-conventions` variants + `brain-repo-conventions`). */
const SAMPLE_REPO_CONVENTIONS_BODY = [
  'Folder layout: `src/app/<domain>/` per bounded context, one `*.module.ts` per domain.',
  'Prefer `type` over `interface` for object shapes; reserve `interface` for declaration merging.',
  'Every exported function gets a one-line doc comment explaining WHY, not WHAT.',
].join('\n');

const SAMPLE_REPO_CONVENTIONS = { name: 'acme-house-style', body: SAMPLE_REPO_CONVENTIONS_BODY };

/** Representative saved preview recipe (the `-preview-recipe` variants). */
const SAMPLE_RECIPE = '## Sample\n- docker compose up -d postgres\n- atlas-svc run --name web --port 3000 …';

/** Representative rendered workspace-profile snapshot (the `brain-workspace-profile` variant). */
const SAMPLE_WORKSPACE_PROFILE = [
  'Mounts: shared-rw `~/.cache/acme-build` (build cache).',
  'Setup script: `pnpm install --frozen-lockfile && pnpm build:packages`.',
  'Secrets: `DATABASE_URL`, `GITHUB_TOKEN` (granted).',
  'MCP servers: github (repo scope).',
  'Skills: nestjs-best-practices.',
  'House style: acme-house-style.',
].join('\n');

export const AGENT_PROMPTS: AgentPromptInfo[] = [
  { id: 'brain', agent: Agent.ATLAS_MAIN, note: 'job brain turn', ctx: { jobKind: 'feature' } },
  { id: 'brain-onboarding', agent: Agent.ATLAS_MAIN, note: 'job brain — onboarding', ctx: { jobKind: 'onboarding' } },
  { id: 'brain-bugfix', agent: Agent.ATLAS_MAIN, note: 'job brain — bugfix job kind', ctx: { jobKind: 'bugfix' } },
  { id: 'brain-event', agent: Agent.ATLAS_MAIN, note: 'job brain — event job kind', ctx: { jobKind: 'event' } },
  { id: 'brain-review', agent: Agent.ATLAS_MAIN, note: 'job brain — review job kind', ctx: { jobKind: 'review' } },
  {
    id: 'brain-org-instructions',
    agent: Agent.ATLAS_MAIN,
    note: 'job brain — with standing operator/org instructions',
    ctx: { jobKind: 'feature', settings: { userOrgInstructions: SAMPLE_ORG_INSTRUCTIONS } },
  },
  {
    id: 'brain-repo-conventions',
    agent: Agent.ATLAS_MAIN,
    note: 'job brain — with an attached repo house-style profile',
    ctx: { jobKind: 'feature', settings: { repoConventions: SAMPLE_REPO_CONVENTIONS } },
  },
  {
    id: 'brain-workspace-profile',
    agent: Agent.ATLAS_MAIN,
    note: 'job brain — with a populated workspace profile snapshot',
    ctx: { jobKind: 'feature', settings: { workspaceProfile: SAMPLE_WORKSPACE_PROFILE } },
  },
  { id: 'worker-orchestrate', agent: Agent.WORKER, note: 'build thread orchestrator', ctx: { jobKind: 'feature' } },
  { id: 'worker-bugfix', agent: Agent.WORKER, note: 'build thread orchestrator — bugfix job kind', ctx: { jobKind: 'bugfix' } },
  { id: 'worker-event', agent: Agent.WORKER, note: 'build thread orchestrator — event job kind', ctx: { jobKind: 'event' } },
  {
    id: 'worker-preview-recipe',
    agent: Agent.WORKER,
    note: 'WORKER with a repo preview recipe',
    ctx: { previewInstructions: SAMPLE_RECIPE, turnPhase: 'batch' },
  },
  { id: 'ship-master-review', agent: Agent.MASTER_REVIEW, note: 'ship Codex master review', ctx: {} },
  { id: 'autofix-review', agent: Agent.AUTOFIX_REVIEW, note: 'auto-fix review pass', ctx: {} },
  {
    id: 'autofix-review-conventions',
    agent: Agent.AUTOFIX_REVIEW,
    note: 'auto-fix review pass — with an attached repo house-style profile',
    ctx: { settings: { repoConventions: SAMPLE_REPO_CONVENTIONS } },
  },
  { id: 'autofix-fix', agent: Agent.AUTOFIX_FIX, note: 'auto-fix fix turn', ctx: {} },
  {
    id: 'autofix-fix-conventions',
    agent: Agent.AUTOFIX_FIX,
    note: 'auto-fix fix turn — with an attached repo house-style profile',
    ctx: { settings: { repoConventions: SAMPLE_REPO_CONVENTIONS } },
  },
  { id: 'subagent-explore', agent: Agent.EXPLORE, note: 'engine explore subagent', ctx: {} },
  { id: 'subagent-docs', agent: Agent.DOCS, note: 'engine docs subagent', ctx: {} },
  { id: 'subagent-review', agent: Agent.REVIEW_AGENT, note: 'engine review subagent', ctx: {} },
  {
    id: 'subagent-review-conventions',
    agent: Agent.REVIEW_AGENT,
    note: 'engine review subagent — with an attached repo house-style profile',
    ctx: { settings: { repoConventions: SAMPLE_REPO_CONVENTIONS } },
  },
  { id: 'subagent-debug', agent: Agent.DEBUG, note: 'engine debug subagent', ctx: {} },
  { id: 'subagent-test', agent: Agent.TEST, note: 'engine test subagent', ctx: {} },
  { id: 'subagent-validate', agent: Agent.VALIDATE, note: 'engine live-validation + evidence subagent', ctx: {} },
  {
    id: 'subagent-validate-preview-recipe',
    agent: Agent.VALIDATE,
    note: 'validate with a repo preview recipe',
    ctx: { previewInstructions: SAMPLE_RECIPE },
  },
  { id: 'subagent-prototype', agent: Agent.PROTOTYPE, note: 'engine design-fidelity prototype subagent', ctx: {} },
  { id: 'subagent-writer', agent: Agent.FAN_OUT, note: 'engine implement/implement-deep writer', ctx: {} },
  {
    id: 'subagent-writer-conventions',
    agent: Agent.FAN_OUT,
    note: 'engine implement/implement-deep writer — with an attached repo house-style profile',
    ctx: { settings: { repoConventions: SAMPLE_REPO_CONVENTIONS } },
  },
  { id: 'meta-plan-review', agent: Agent.META_PLAN_REVIEW, note: 'plan-review Codex chain', ctx: {} },
  {
    id: 'meta-plan-review-conventions',
    agent: Agent.META_PLAN_REVIEW,
    note: 'plan-review Codex chain — with an attached repo house-style profile',
    ctx: { settings: { repoConventions: SAMPLE_REPO_CONVENTIONS } },
  },
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
