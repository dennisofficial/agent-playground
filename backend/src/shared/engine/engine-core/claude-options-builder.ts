import type { HookCallback, Options } from '@anthropic-ai/claude-agent-sdk';
import type { EngineLocalHooks, JitInjectionRule } from '@workspace/agent-engine';
import { join } from 'node:path';
import {
  detectInstallCommand,
  githubFetchGuardRule,
  installAwarenessRule,
} from '../../prompt-kit/jit';
import type { EngineHomeKey } from '../engine-home';
import { INTERNAL_PROFILE_AWARENESS_TOOL, type RunEngineArgs } from '../engine.types';
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

const INSTALL_AWARENESS_TIMEOUT_MS = 5_000;

export interface BuildClaudeOptionsParams {
  cwd: string;
  systemPrompt: RunEngineArgs['systemPrompt'];
  planMode: boolean;
  readOnly: boolean;
  mode: RunEngineArgs['mode'];
  args: RunEngineArgs;
  bridgeToolNames?: string[];
  claudeConfigDir: string;
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
  setCapturedPlan: (plan: string) => void;
  getContextTokens: () => number | undefined;
  onJitInjection?: (inj: { toolUseId: string; rule: JitInjectionRule; text: string }) => void;
}

export function buildClaudeOptions(p: BuildClaudeOptionsParams): Options {
  const installAwarenessEnabled = installAwarenessRule.enabled && !!p.bridgeCall;

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
      const cmd = typeof inp.tool_input?.command === 'string' ? inp.tool_input.command : '';
      if (!detectInstallCommand(cmd)) return {};
      try {
        const text = await Promise.race([
          p.bridgeCall!(INTERNAL_PROFILE_AWARENESS_TOOL, {
            command: cmd,
            sessionType: p.sandboxKey.type,
          }),
          new Promise<null>((r) => setTimeout(() => r(null), INSTALL_AWARENESS_TIMEOUT_MS)),
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

  const fetchPostToolUseHooks: HookCallback[] = [];
  const githubGuard = githubFetchGuardRule.trigger;
  const fetchToolMatcher = githubGuard.kind === 'url-match' ? githubGuard.toolMatcher : '';
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
    settingSources: ['user', 'project'],
    skills: 'all',
    tools: p.planMode ? PLAN_TOOLS : p.readOnly ? REVIEW_TOOLS : WORKER_TOOLS,
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
    settings: { attribution: { commit: '', pr: '' } },
    abortController: p.abortController,
    env: p.subprocessEnv,
    stderr: p.captureStderr,
    ...(p.sessionId ? { resume: p.sessionId } : {}),
    ...(p.model ? { model: p.model } : {}),
    ...(claudeEffort ? { effort: claudeEffort } : {}),
    betas: ['context-1m-2025-08-07'],
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
    ...(p.richStream
      ? {
          includePartialMessages: true,
          thinking: {
            type: 'adaptive' as const,
            display: 'summarized' as const,
          },
          forwardSubagentText: true,
        }
      : {}),
    ...(p.extraClaudeOptions ?? {}),
  };
}
