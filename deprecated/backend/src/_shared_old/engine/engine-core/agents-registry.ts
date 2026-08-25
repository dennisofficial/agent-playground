import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { Agent } from '../../prompt-kit/system/agent';
import { renderAgentPrompt } from '../../prompt-kit/system/assemble';
import type { PromptCtx } from '../../prompt-kit/system/prompt-ctx';
import type { RunEngineArgs } from '../engine.types';
import { LSP_NAV_TOOL_NAMES, LSP_TOOL_NAMES, qualifyLspToolNames } from '../lsp-tools';

const WEB_TOOLS = ['WebSearch', 'WebFetch'];
const SUBAGENT_MGMT_TOOLS = ['SendMessage', 'TaskOutput', 'TaskStop'];
export const WORKER_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'Write',
  'Edit',
  'Bash',
  'Task',
  'Skill',
  ...SUBAGENT_MGMT_TOOLS,
  ...WEB_TOOLS,
];
export const PLAN_TOOLS = [...WORKER_TOOLS, 'ExitPlanMode'];
export const REVIEW_TOOLS = ['Read', 'Glob', 'Grep', 'Bash', 'Skill', ...WEB_TOOLS];
export const AUTO_APPROVE = ['Read', 'Glob', 'Grep', 'Task', ...SUBAGENT_MGMT_TOOLS, ...WEB_TOOLS];

const LSP_NAV_TOOLS = qualifyLspToolNames(LSP_NAV_TOOL_NAMES);
const LSP_WRITE_TOOLS = qualifyLspToolNames(LSP_TOOL_NAMES);

export const SUBAGENTS: NonNullable<Options['agents']> = {
  explore: {
    description:
      'Read-only CODE explorer. Delegate investigation here — locating files, tracing how a ' +
      'feature works, mapping conventions — to keep the main context clean and save tokens. Returns a ' +
      "concise findings summary, not raw file dumps. Also handles the repo's OWN docs (CLAUDE.md, " +
      'README, ARCHITECTURE.md, docs/). State the search breadth you want: "quick" (one targeted ' +
      'lookup), "medium" (moderate exploration), or "very thorough" (sweep multiple locations and ' +
      'naming conventions). For EXTERNAL library/framework/API documentation, use `docs` instead.',
    tools: ['Read', 'Glob', 'Grep', ...WEB_TOOLS, ...LSP_NAV_TOOLS],
    model: 'claude-sonnet-5',
    effort: 'medium',
    prompt: renderAgentPrompt(Agent.EXPLORE),
  },
  docs: {
    description:
      'External library/framework/API documentation researcher — answers "how do I use X" / "what\'s the ' +
      "current API for Y\" from the LIBRARY'S OWN docs on the web, not from this repo's source. Returns a " +
      'synthesized, cited, version-aware answer. Use `explore` for how THIS codebase (and its own docs) ' +
      'work; use `docs` for third-party packages, frameworks, and external APIs.',
    tools: ['Read', 'Glob', 'Grep', ...WEB_TOOLS],
    model: 'claude-sonnet-5',
    effort: 'low',
    prompt: renderAgentPrompt(Agent.DOCS),
  },
  review: {
    description:
      'Read-only code reviewer. Hand it a diff (or changed files) plus the intent, and it returns ' +
      'concrete findings — correctness bugs, behavior silently removed, convention/altitude drift, ' +
      'missing edge cases — grounded in the surrounding code. A cheap second pair of eyes before a step ' +
      'is called done. It reports; it does NOT fix.',
    tools: ['Read', 'Glob', 'Grep', ...WEB_TOOLS, ...LSP_NAV_TOOLS],
    model: 'claude-sonnet-5',
    effort: 'high',
    prompt: renderAgentPrompt(Agent.REVIEW_AGENT),
  },
  debug: {
    description:
      'Read-only root-cause tracer. Give it a failure (error, stack trace, failing test, wrong ' +
      'behavior) and it traces the cause through the code and names the exact fix site and smallest fix ' +
      '— it does not run commands or change anything. Use `test` to actually run the verification.',
    tools: ['Read', 'Glob', 'Grep', ...WEB_TOOLS, ...LSP_NAV_TOOLS],
    model: 'claude-sonnet-5',
    effort: 'high',
    prompt: renderAgentPrompt(Agent.DEBUG),
  },
  test: {
    description:
      "Runs the repository's verification (typecheck/build/lint/tests) in the worktree and returns a " +
      'DIAGNOSIS, not raw logs — pass/fail per command, and for failures the specific errors and likely ' +
      'cause. Keeps thousands of lines of test output out of your context. It can run commands (Bash) ' +
      'but does NOT edit files or change git state.',
    tools: ['Read', 'Glob', 'Grep', 'Bash', ...WEB_TOOLS],
    model: 'claude-sonnet-5',
    effort: 'low',
    prompt: renderAgentPrompt(Agent.TEST),
  },
};

const WRITER_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'Write',
  'Edit',
  'Bash',
  ...WEB_TOOLS,
  ...LSP_WRITE_TOOLS,
];
export const WRITER_SUBAGENTS: NonNullable<Options['agents']> = {
  implement: {
    description:
      'WRITER subagent (Sonnet) — your DEFAULT writer. Delegate a SUBSTANTIAL, long-running ' +
      'implementation slice here (a whole feature area, a multi-file change), NAMING the exact files ' +
      'it may touch. It edits the worktree and returns a tight summary of what it changed. Reach for ' +
      'it whenever the work is big enough that doing it inline would burn your context — that is the ' +
      'point of offloading it. Do NOT use it for small/quick edits (do those yourself). Run ONE writer ' +
      'at a time. For a genuinely hard, judgment-heavy slice where Sonnet-level coding is not enough, ' +
      'escalate to `implement-deep`.',
    tools: WRITER_TOOLS,
    model: 'claude-sonnet-5',
    effort: 'high',
    prompt: renderAgentPrompt(Agent.FAN_OUT),
  },
  'implement-deep': {
    description:
      'ESCALATION WRITER subagent (Opus) — same contract as `implement`, reserved for the genuinely ' +
      'hard, judgment-heavy long-running slices (subtle design, tricky algorithms, dense cross-cutting ' +
      'refactors) where Sonnet-level coding is not enough. Use SPARINGLY — prefer `implement`. Same ' +
      'rules: it edits only the files you name and returns a tight summary; run one writer at a time.',
    tools: WRITER_TOOLS,
    model: 'opus',
    effort: 'high',
    prompt: renderAgentPrompt(Agent.FAN_OUT),
  },
};

export const VALIDATE_SUBAGENT: NonNullable<Options['agents']> = {
  validate: {
    description:
      'LIVE validation + evidence capture (Sonnet). Delegate END-TO-END validation here to keep your ' +
      'context clean: it BOOTS the change and exercises it as a real caller would (atlas-svc services, ' +
      "curl, Playwright UI drives, the repo's own e2e/smoke), then leaves the PROOF under " +
      "`$ATLAS_EVIDENCE_DIR` (logs, screenshots, a `RESULTS.md` index) that renders in the operator's " +
      'EVIDENCE panel. Returns a verdict + the observed behavior + the exact evidence paths it wrote — reference those instead of ' +
      'recapturing. Use `test` instead for a fast typecheck/build/unit diagnosis with no artifacts.',
    tools: ['Read', 'Glob', 'Grep', 'Bash', 'Write', ...WEB_TOOLS],
    model: 'claude-sonnet-5',
    effort: 'medium',
    prompt: renderAgentPrompt(Agent.VALIDATE),
  },
};

export const PROTOTYPE_SUBAGENT: NonNullable<Options['agents']> = {
  prototype: {
    description:
      'Design-fidelity PROTOTYPE subagent (Sonnet) — a lightweight in-house claude.ai/design. Delegate a UI ' +
      "MOCKUP here, NAMING the exact `/context/artifacts/<file>.html` for it to write. It DISCOVERS the app's " +
      'real design system (tokens, theme, fonts, components) and reproduces it faithfully — no invented ' +
      'palette — then renders + screenshots the result to self-check before returning a tight summary (the ' +
      'artifact path + the design sources it grounded in). Prefer it over a generic writer for UI previews.',
    tools: ['Read', 'Glob', 'Grep', 'Bash', 'Write', ...WEB_TOOLS],
    model: 'claude-sonnet-5',
    effort: 'medium',
    prompt: renderAgentPrompt(Agent.PROTOTYPE),
  },
};

const CONVENTION_FACING_SUBAGENTS: Record<string, Agent> = {
  implement: Agent.FAN_OUT,
  'implement-deep': Agent.FAN_OUT,
  review: Agent.REVIEW_AGENT,
};

const PREVIEW_FACING_SUBAGENTS: Record<string, Agent> = {
  validate: Agent.VALIDATE,
};

export function applyPerRunCtxToAgents(
  agents: NonNullable<Options['agents']>,
  args: {
    repoConventions: RunEngineArgs['repoConventions'];
    previewInstructions?: string | null;
  },
): NonNullable<Options['agents']> {
  const preview = args.previewInstructions?.trim() ? args.previewInstructions : null;
  if (!args.repoConventions && !preview) return agents;
  const out = { ...agents };
  const targets = new Map<string, Agent>();
  if (args.repoConventions) {
    for (const [name, agent] of Object.entries(CONVENTION_FACING_SUBAGENTS))
      targets.set(name, agent);
  }
  if (preview) {
    for (const [name, agent] of Object.entries(PREVIEW_FACING_SUBAGENTS)) targets.set(name, agent);
  }
  for (const [name, agent] of targets) {
    if (!out[name]) continue;
    const ctx: PromptCtx = {
      ...(args.repoConventions ? { settings: { repoConventions: args.repoConventions } } : {}),
      ...(preview ? { previewInstructions: preview } : {}),
    };
    out[name] = { ...out[name], prompt: renderAgentPrompt(agent, ctx) };
  }
  return out;
}
