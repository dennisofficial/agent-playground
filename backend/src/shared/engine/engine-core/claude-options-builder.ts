import type { HookCallback, Options } from '@anthropic-ai/claude-agent-sdk';
import { join } from 'node:path';
import type {
  EngineLocalHooks,
  JitInjectionRule,
} from '@workspace/agent-engine';
import {
  detectInstallCommand,
  githubFetchGuardRule,
  installAwarenessRule,
} from '../../prompt-kit/jit';
import type { EngineHomeKey } from '../engine-home';
import {
  INTERNAL_PROFILE_AWARENESS_TOOL,
  type RunEngineArgs,
} from '../engine.types';
import {
  applyPerRunCtxToAgents,
  AUTO_APPROVE,
  PLAN_TOOLS,
  PROTOTYPE_SUBAGENT,
  REVIEW_TOOLS,
  SUBAGENTS,
  VALIDATE_SUBAGENT,
  WORKER_TOOLS,
  WRITER_SUBAGENTS,
} from './agents-registry';
import { makeCanUseTool } from './tool-permission';
import { toClaudeEffort } from './usage';

/** Bound the install-awareness host round-trip so a slow host / Haiku call never delays the model's next step. */
const INSTALL_AWARENESS_TIMEOUT_MS = 5_000;

/** Every free variable the inline SDK `Options` assembly in `runClaude` closed over. Passed explicitly so the
 *  builder is a pure function — it reads live loop state (the `PostToolUse` context hook needs the CURRENT
 *  `contextTokens`) via `getContextTokens`, and hands the plan-capture callback back through `setCapturedPlan`. */
export interface BuildClaudeOptionsParams {
  cwd: string;
  systemPrompt: RunEngineArgs['systemPrompt'];
  planMode: boolean;
  readOnly: boolean;
  mode: RunEngineArgs['mode'];
  args: RunEngineArgs;
  bridgeToolNames?: string[];
  claudeConfigDir: string;
  /** The org-scoped skills-store mount root (`this.skillsRoot()`), if the run has one. */
  skillsStoreRoot: string | undefined;
  subprocessEnv: Record<string, string | undefined>;
  abortController: AbortController;
  captureStderr: (data: string) => void;
  hooks?: EngineLocalHooks;
  bridgeCall?: RunEngineArgs['bridgeCall'];
  extraClaudeOptions?: Record<string, unknown>;
  sandboxKey: EngineHomeKey;
  sessionId?: string;
  model?: string;
  richStream?: boolean;
  /** Captures the plan `ExitPlanMode` yields on a plan turn (the substance of a plan turn's result). */
  setCapturedPlan: (plan: string) => void;
  /** Reads the LIVE main-agent context occupancy the `postToolUseContext` hook needs mid-query (declared via
   *  `let` in `runClaude`, mutated per round-trip). */
  getContextTokens: () => number | undefined;
  /** Reports a JIT additionalContext injection the instant a PostToolUse hook produces it, keyed by the
   *  SDK tool_use_id so the host can tag the exact tool block (decision d6). */
  onJitInjection?: (inj: { toolUseId: string; rule: JitInjectionRule; text: string }) => void;
}

/**
 * Assemble the Claude Agent SDK `Options` for one turn. Pure: no `this`, no mutation of the loop state — it
 * reads it (context occupancy) and writes back only through the two callbacks. Extracted verbatim from
 * `runClaude`; every ordering/comment is load-bearing (the hook matcher groups, the plan/read-only tool
 * allowlists, the streaming-input betas), so this is code motion, not a rewrite.
 */
export function buildClaudeOptions(p: BuildClaudeOptionsParams): Options {
  // Install-awareness (PostToolUse hook, added to `options` below): a Bash install is detected in-container
  // (cheap regex gate) and round-tripped to the reserved `__profile_awareness` host tool via `bridgeCall`.
  // Only wired when this turn carries a tool bridge — otherwise the round-trip has no transport (fail-silent).
  const installAwarenessEnabled =
    installAwarenessRule.enabled && !!p.bridgeCall;

  // PostToolUse Bash hooks, one callback per enabled feature (built before `options` so the literal just
  // spreads the assembled array). The atlas-svc nudge is delivered through the engine-local
  // `postToolUseContext` hook (shared with the Codex adapter — see `buildEngineLocalHooks` above);
  // install-awareness rides the SAME `Bash` matcher. Callbacks read `getContextTokens()` (the live main-agent
  // occupancy) and only run later, mid-query.
  const toolUseIdOf = (input: unknown): string =>
    (input as { tool_use_id?: string }).tool_use_id ?? '';

  const bashPostToolUseHooks: HookCallback[] = [];
  if (p.hooks?.postToolUseContext) {
    bashPostToolUseHooks.push(async (input) => {
      const inp = input as { tool_name?: string; tool_input?: unknown };
      const additionalContext = p.hooks!.postToolUseContext!(
        inp.tool_name ?? '',
        inp.tool_input,
        p.getContextTokens() ?? 0,
      );
      if (additionalContext == null) return {};
      p.onJitInjection?.({
        toolUseId: toolUseIdOf(input),
        rule: 'svc-nudge',
        text: additionalContext,
      });
      return {
        hookSpecificOutput: {
          hookEventName: 'PostToolUse' as const,
          additionalContext,
        },
      };
    });
  }
  if (installAwarenessEnabled) {
    bashPostToolUseHooks.push(async (input) => {
      const inp = input as {
        tool_name?: string;
        tool_input?: { command?: unknown };
      };
      if (inp.tool_name !== 'Bash') return {};
      const cmd =
        typeof inp.tool_input?.command === 'string'
          ? inp.tool_input.command
          : '';
      if (!detectInstallCommand(cmd)) return {};
      try {
        const text = await Promise.race([
          p.bridgeCall!(INTERNAL_PROFILE_AWARENESS_TOOL, {
            command: cmd,
            sessionType: p.sandboxKey.type,
          }),
          new Promise<null>((r) =>
            setTimeout(() => r(null), INSTALL_AWARENESS_TIMEOUT_MS),
          ),
        ]);
        if (typeof text !== 'string' || !text) return {};
        p.onJitInjection?.({
          toolUseId: toolUseIdOf(input),
          rule: 'install-awareness',
          text,
        });
        return {
          hookSpecificOutput: {
            hookEventName: 'PostToolUse' as const,
            additionalContext: text,
          },
        };
      } catch {
        return {};
      }
    });
  }

  // PostToolUse fetch hooks: the github-fetch guard, registered under its OWN matcher group so ONLY fetch
  // tools (native `WebFetch` + the `fetch` MCP) invoke it. When the fetched URL is a github.com HTML page,
  // append a reminder to use `gh api`/git instead — GitHub's web UI is client-rendered, so the fetch returns
  // chrome, not content. Pure/local (no host round-trip), so no timeout guard is needed.
  const fetchPostToolUseHooks: HookCallback[] = [];
  const githubGuard = githubFetchGuardRule.trigger;
  const fetchToolMatcher =
    githubGuard.kind === 'url-match' ? githubGuard.toolMatcher : '';
  if (githubFetchGuardRule.enabled && githubGuard.kind === 'url-match') {
    fetchPostToolUseHooks.push(async (input) => {
      const url = (input as { tool_input?: { url?: unknown } }).tool_input?.url;
      const fetched = typeof url === 'string' ? url : '';
      if (!githubGuard.match(fetched)) return {};
      const text = githubFetchGuardRule.render({ url: fetched });
      p.onJitInjection?.({
        toolUseId: toolUseIdOf(input),
        rule: 'github-fetch-guard',
        text,
      });
      return {
        hookSpecificOutput: {
          hookEventName: 'PostToolUse' as const,
          additionalContext: text,
        },
      };
    });
  }

  const claudeEffort = toClaudeEffort(p.args.modelReasoningEffort);

  return {
    cwd: p.cwd,
    systemPrompt: p.systemPrompt,
    // 'user' loads <CLAUDE_CONFIG_DIR>/settings.json (missing → no-op; the only thing Atlas places there is
    // the composed `skills/` dir). 'project' turns on NATIVE worktree memory: the repo's root CLAUDE.md loads
    // at session launch, and nested CLAUDE.md in subdirectories loads on-demand (once) when the agent reads a
    // file in that subtree — replacing the old prose-only "go read CLAUDE.md yourself" orientation.
    // Our programmatic options here stay AUTHORITATIVE over a worktree's own `.claude/`: `model` and
    // `disallowedTools` win, so a repo cannot escalate (swap the model, re-enable a removed tool, or bypass).
    // A worktree `.claude/settings.json` can only MERGE extra hooks or RESTRICT via `permissions.deny` —
    // disrupt, never compromise. Trusted-repo posture (the user's own files, like Claude Code on a laptop);
    // spiked end-to-end against SDK 0.3.204. If untrusted third-party `.claude/` ever needs isolating, the
    // escape hatch is a memory-only PostToolUse injection hook keeping settingSources back at ['user'].
    settingSources: ['user', 'project'],
    // Turns skills on for the whole resolved set — the single place the SDK needs (auto-enables the Skill
    // tool; no plugins key, no manual 'Skill' in allowedTools). See WORKER_TOOLS/REVIEW_TOOLS below for
    // why 'Skill' is still added to the `tools` ALLOWLIST (that list restricts, independent of this).
    skills: 'all',
    tools: p.planMode ? PLAN_TOOLS : p.readOnly ? REVIEW_TOOLS : WORKER_TOOLS,
    // Programmatic subagent definitions. With `settingSources: ['user','project']` a worktree's own
    // project-scope `.claude/agents/` would ALSO be sourced (merged with these), but Atlas ships no such dir
    // and this repo has none, so the programmatic map below is authoritative in practice by simple absence.
    // Advisory subagents (read-only, Sonnet) are always available; the WRITER subagents
    // (implement/implement-deep), the build-time VALIDATE subagent, and the design-fidelity PROTOTYPE
    // subagent are added ONLY on EXECUTE turns, so a plan/brain/review turn can never fan out a
    // file-mutating or evidence-writing subagent. See
    // SUBAGENTS / WRITER_SUBAGENTS / VALIDATE_SUBAGENT / PROTOTYPE_SUBAGENT.
    agents: applyPerRunCtxToAgents(
      p.mode === 'execute'
        ? {
            ...SUBAGENTS,
            ...WRITER_SUBAGENTS,
            ...VALIDATE_SUBAGENT,
            ...PROTOTYPE_SUBAGENT,
          }
        : SUBAGENTS,
      {
        repoConventions: p.args.repoConventions,
        previewInstructions: p.args.previewInstructions,
      },
    ),
    // Host-side tools reach the in-sandbox session as an MCP server (the tool bridge). Surface
    // their qualified names (`mcp__<server>__<tool>`) in allowedTools so they're auto-approved —
    // they're host-controlled, never a human prompt. Empty for non-bridge turns (workers).
    allowedTools: [...AUTO_APPROVE, ...(p.bridgeToolNames ?? [])],
    canUseTool: makeCanUseTool(
      p.readOnly,
      [p.cwd, ...(p.args.writableRoots ?? [])],
      (plan) => {
        p.setCapturedPlan(plan);
      },
      {
        composedSkillsDir: join(p.claudeConfigDir, 'skills'),
        skillsStoreRoot: p.skillsStoreRoot,
        skills: p.args.skills,
        granted: new Set(p.args.grantedSkills ?? []),
      },
      p.hooks?.writeGuard,
    ),
    permissionMode: p.planMode ? 'plan' : 'default',
    // Suppress the SDK's default "Co-Authored-By: Claude" attribution.
    settings: { attribution: { commit: '', pr: '' } },
    abortController: p.abortController,
    env: p.subprocessEnv,
    // The SDK routes the Claude Code subprocess's stderr here (the real API/transport error the
    // `error_during_execution` subtype otherwise hides). Unconditional: worker turns fail too.
    stderr: p.captureStderr,
    ...(p.sessionId ? { resume: p.sessionId } : {}),
    ...(p.model ? { model: p.model } : {}),
    ...(claudeEffort ? { effort: claudeEffort } : {}),
    // Enable the 1M-token context window explicitly. Opus 4.x and Sonnet 5 negotiate it automatically, but
    // we pass the beta as belt-and-suspenders so a builder session that fills past 200k does NOT truncate —
    // Leg rotation's HARD threshold (200k) depends on there being headroom ABOVE it to author the handoff
    // (see the context-rot plan). The SDK forwards `anthropic-beta: context-1m-2025-08-07`.
    betas: ['context-1m-2025-08-07'],
    // PostToolUse hooks, split by matcher group. `Bash`: the atlas-svc nudge (via the engine-local
    // `postToolUseContext` hook, shared with the Codex adapter) plus install-awareness. Fetch tools
    // (`WebFetch|mcp__fetch__.*`): the github-fetch guard. Each callback only ATTACHES `additionalContext` to
    // the tool result (a free-form string yielded to the model after the tool result — verified against the
    // shipped CLI; `updatedToolOutput` is shape-validated against the tool's output and would error), never
    // altering the tool input or its output.
    ...(bashPostToolUseHooks.length > 0 || fetchPostToolUseHooks.length > 0
      ? {
          hooks: {
            PostToolUse: [
              ...(bashPostToolUseHooks.length > 0
                ? [{ matcher: 'Bash', hooks: bashPostToolUseHooks }]
                : []),
              ...(fetchPostToolUseHooks.length > 0
                ? [
                    {
                      matcher: fetchToolMatcher,
                      hooks: fetchPostToolUseHooks,
                    },
                  ]
                : []),
            ],
          },
        }
      : {}),
    // Rich streaming (the thread brain): partial-message stream → token-level deltas, and extended
    // thinking → thinking blocks. Adaptive lets Claude decide thinking depth per turn.
    // forwardSubagentText: forward a subagent's FULL text+thinking (not just its tool calls) tagged with
    // `parent_tool_use_id`, so the brain turn can render each subagent run as its own nested transcript.
    ...(p.richStream
      ? {
          includePartialMessages: true,
          // `display: 'summarized'` is load-bearing: without it the adaptive default is `omitted`, which
          // streams thinking blocks with EMPTY text — the `&& block.thinking` guards below then drop them,
          // so nothing is ever emitted or persisted. Summarized surfaces the reasoning for debugging.
          thinking: {
            type: 'adaptive' as const,
            display: 'summarized' as const,
          },
          forwardSubagentText: true,
        }
      : {}),
    // R1 tool-bridge: optional extra options (e.g. mcpServers) from the in-container entrypoint.
    ...(p.extraClaudeOptions ?? {}),
  };
}
