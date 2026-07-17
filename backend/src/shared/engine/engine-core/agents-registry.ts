import type { Options } from '@anthropic-ai/claude-agent-sdk';
// Import from the DIRECT (Nest-free) assembly path, not the prompt-kit barrel — this module bundles into the
// in-container engine, and the barrel re-exports the NestJS PromptService/PromptKitModule.
import { Agent } from '../../prompt-kit/system/agent';
import { renderAgentPrompt } from '../../prompt-kit/system/assemble';
import type { PromptCtx } from '../../prompt-kit/system/prompt-ctx';
import type { RunEngineArgs } from '../engine.types';
import { LSP_NAV_TOOL_NAMES, LSP_TOOL_NAMES, qualifyLspToolNames } from '../lsp-tools';

// Claude built-in tool sets. `tools` RESTRICTS the available set (unlike `allowedTools`, which only
// auto-approves).
// Web access: WebSearch runs server-side (no container egress needed); WebFetch runs client-side in
// the sandbox (the per-sandbox bridge network has NAT egress). Enabled on every turn so the engine can
// pull current docs / latest versions. This is a personal, trusted deployment — see `agents/web` notes.
const WEB_TOOLS = ['WebSearch', 'WebFetch'];
// `Task` spawns a subagent — see SUBAGENTS below (read-only, Sonnet-pinned) for token-cheap exploration.
// Subagent-management tools (SDK 0.3.x). Once a subagent is spawned with a `name` it stays ADDRESSABLE, so
// the orchestrator's only recovery from a stall/failure is no longer a fresh `Task` that starts from zero:
//   • SendMessage({to}) — nudge/continue an existing agent WITH ITS ACCUMULATED CONTEXT INTACT (the whole
//     point: a stalled or transiently-failed subagent — e.g. an API 500 — is recovered by nudging, not by
//     throwing away everything it learned and respawning);
//   • TaskOutput({task_id}) — peek a running background agent without blocking;
//   • TaskStop({task_id}) — cleanly abandon a truly-wedged one before falling back to a respawn.
// `tools` is a RESTRICTING allowlist, so these must be named for the model to call them at all; auto-approved
// below so nudging/peeking/stopping never stalls on a permission prompt (like `Task` itself). Deliberately
// NOT given to REVIEW_TOOLS (a review turn shouldn't fan out) nor to the subagents' own `tools:` arrays
// (subagents don't recurse).
const SUBAGENT_MGMT_TOOLS = ['SendMessage', 'TaskOutput', 'TaskStop'];
// 'Skill' loads a discovered skill's body — read-only in itself (the SDK's `skills: 'all'` option auto-
// approves it into `allowedTools`, but `tools` below RESTRICTS the available set independent of that, so it
// must still be named here or the SDK's own enablement gets stripped).
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
// A plan turn adds ExitPlanMode — native plan mode's turn-ender and the one place the FULL plan text
// reaches canUseTool headlessly (the CLI auto-writes the plan file, then calls ExitPlanMode with the
// plan in its input).
export const PLAN_TOOLS = [...WORKER_TOOLS, 'ExitPlanMode'];
// A read-only review turn gets the read tools (+ web for verifying against current docs) + Skill. No Task —
// a review turn shouldn't fan out.
export const REVIEW_TOOLS = ['Read', 'Glob', 'Grep', 'Bash', 'Skill', ...WEB_TOOLS];
// Auto-approve safe reads, web, and subagent spawning; writes/bash fall through to canUseTool where the
// boundary is re-applied.
export const AUTO_APPROVE = ['Read', 'Glob', 'Grep', 'Task', ...SUBAGENT_MGMT_TOOLS, ...WEB_TOOLS];

// LSP navigation/rename (`atlas-lsp-ts`, registered per-turn — see sandbox/image/lsp-bridge-options.ts).
// Subagent `tools:` arrays are explicit, not inherited from the parent turn's `allowedTools`, so each
// subagent that should get these needs them listed here. Read-only investigators get navigation only
// (no `rename_symbol`); writers get the full set since they're the ones actually renaming things.
const LSP_NAV_TOOLS = qualifyLspToolNames(LSP_NAV_TOOL_NAMES);
const LSP_WRITE_TOOLS = qualifyLspToolNames(LSP_TOOL_NAMES);

// Subagent types the engine can spawn via `Task`. With `settingSources: ['user','project']` a worktree's
// own project-scope `.claude/agents/` would be sourced too, but Atlas ships no such dir and this repo has
// none, so this map is the ONLY set of spawnable subagents in practice — every subagent is Sonnet-pinned by
// construction (cheaper than the Opus brain). All are advisory: they investigate and report, and NONE
// can Write/Edit (only the calling turn changes files). `test` is the one exception to "read-only": it
// gets Bash so it can RUN the repo's verification, but it still cannot edit/commit. This keeps delegated
// work token-cheap and side-effect-free, while letting a worker push noisy test output off its context.
//
// EFFORT: each subagent pins its own `effort`. A subagent that OMITS `effort` inherits the SESSION effort
// (the spawning orchestrator's — brain/builder run at `high`, see thread-kind/registry.ts), so leaving it
// unset spends `high` even on mechanical stages. We split by how effort-sensitive the stage is: the
// mechanical FETCHERS run cheaper (`low`/`medium`) while the judgment WRITERS/reviewers stay `high`. The
// value is the Claude SDK's own effort enum (`Options['agents'][k].effort`); `low|medium|high` pass
// through verbatim (no `toClaudeEffort` mapping needed).
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
    // Self-directs repo search; recall matters (not `low`), but the orchestrator can re-ask (not `high`).
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
    // Pure external doc lookup — mechanical fetch, cheapest tier.
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
    // Review quality is the most effort-sensitive dimension — keep it sharp.
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
    // Root-cause tracing is judgment-heavy — keep it sharp.
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
    // Runs verification + returns a diagnosis — mostly mechanical. Watch diagnosis quality; bump to
    // `medium` if it regresses.
    effort: 'low',
    prompt: renderAgentPrompt(Agent.TEST),
  },
};

// WRITER subagents — the ONLY subagents that can change files. Added to the spawnable set ONLY on
// EXECUTE turns (see `run`), so an advisory plan/brain/review turn can NEVER fan out a file-mutating
// subagent. Confinement: their Write/Edit go through the SAME global `canUseTool` worktree boundary as
// the orchestrator's own writes; Bash is bounded by the per-thread Docker sandbox (the engine runs
// boxed). They have NO `Task` tool — writers cannot recursively fan out (no nesting blowup). The
// orchestrator owns the decomposition and runs writers ONE AT A TIME; file ownership between writers is
// by serialization, not a hard lock (see ORCHESTRATE_EXECUTE_SYSTEM in the driver).
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
    // Writing code is effort-sensitive — keep it sharp.
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
    // The Opus escalation writer — the hardest slices. Keep it sharp.
    effort: 'high',
    prompt: renderAgentPrompt(Agent.FAN_OUT),
  },
};

// VALIDATE subagent — build-time LIVE end-to-end validation + evidence capture. Added ONLY on EXECUTE
// turns (like the writers), so only the builder can spawn it. It gets `Bash` (to boot services via
// atlas-svc, curl endpoints, drive Playwright, run e2e) and `Write` (to author the `$ATLAS_EVIDENCE_DIR`
// evidence bundle + RESULTS.md — the `/context` mount is a writable root, see redis-engine-runner). It has
// NO `Task` (no recursive fan-out). Its "write only under $ATLAS_EVIDENCE_DIR, don't edit code" contract is
// prompt discipline (the `canUseTool` write boundary is per-turn, not per-subagent) — same model as `test`
// being "read-only by prompt". Distinct from `test`: `test` runs typecheck/build/unit → a diagnosis;
// `validate` boots the thing, exercises it live, and leaves durable proof the operator can see.
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
    // Runs e2e but must judge pass/fail — mid tier.
    effort: 'medium',
    prompt: renderAgentPrompt(Agent.VALIDATE),
  },
};

// PROTOTYPE subagent — planning/design-time mockup author. Like `validate` it writes ONLY into
// /context/artifacts (a static HTML preview), so it gets Write + Bash (Bash to run the target repo's
// design-system build and render/screenshot the mockup with on-demand Playwright for a fidelity self-check)
// but NO Edit/LSP (authors one new file, never edits source) and NO Task (no recursive fan-out). Merged on
// EXECUTE turns alongside the writers; the brain runs execute-mode, so it can spawn this at planning time.
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
    // Authors a design-fidelity mockup — mid tier.
    effort: 'medium',
    prompt: renderAgentPrompt(Agent.PROTOTYPE),
  },
};

// The build-facing subagents whose persona must carry the repo's house-style envelope (the FAN_OUT writers
// + the REVIEW_AGENT) → the `Agent` their prompt is assembled from. The host bakes conventions into the
// MAIN-agent `systemPrompt` only; these subagent personas are built HERE from static prompts, so this map is
// the sole seam where the wire-forwarded `repoConventions` can reach them. Read-only advisory subagents
// (explore/docs/debug/test/validate) are intentionally absent — they aren't in the fragment's `usedBy`.
const CONVENTION_FACING_SUBAGENTS: Record<string, Agent> = {
  implement: Agent.FAN_OUT,
  'implement-deep': Agent.FAN_OUT,
  review: Agent.REVIEW_AGENT,
};

// The build-facing subagent whose persona must carry the repo's saved PREVIEW RECIPE, read-only — `validate`
// is the only in-sandbox subagent that ever needs to stand a live preview up. Distinct map (not merged into
// `CONVENTION_FACING_SUBAGENTS`) since it gates on a different per-run signal (`previewInstructions`, not
// `repoConventions`).
const PREVIEW_FACING_SUBAGENTS: Record<string, Agent> = {
  validate: Agent.VALIDATE,
};

/**
 * Fold per-run host context (the repo's house-style envelope, its saved preview recipe) into the build-facing
 * subagent prompts. When the turn carries neither (`repoConventions` absent/null AND `previewInstructions`
 * absent/blank) this returns the map UNCHANGED — byte-identical to today. Otherwise it re-renders the UNION of
 * convention-facing + preview-facing subagents present in this turn's map, each with only the ctx it actually
 * gates on (a subagent not present in this turn's map — e.g. the writers on a non-execute turn — is simply
 * skipped).
 */
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
