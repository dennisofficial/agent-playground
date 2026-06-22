import { EnvService } from '@core/config/env/env.service';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  CanUseTool,
  Options,
  PermissionResult,
} from '@anthropic-ai/claude-agent-sdk';
import type { Codex, ThreadOptions } from '@openai/codex-sdk';
import { execFileSync } from 'node:child_process';
import { resolve as resolvePath } from 'node:path';
import { engineAuthFromEnv } from '../onboarding/env-engine-auth';
import { applyClaudeAuth } from './claude-auth';
import { atlasEngineHomeDir } from './engine-home';
import { ensureCodexAuthHome } from './codex-auth-home';
import { ATLAS_ANTHROPIC_SDK, ATLAS_CODEX_SDK } from './esm.module';
import type {
  EngineAuth,
  EngineRunResult,
  EngineUsage,
  RunEngineArgs,
} from './engine.types';

/**
 * The Atlas v2 EngineRunner — a clean-room, MINIMAL rewrite of v1's Claude/Codex engines combined
 * behind one service. It does exactly four things (the W1 requirements):
 *   1. plan vs execute modes — plan = read-only (Claude's native plan posture / Codex read-only
 *      sandbox), execute = writes confined to the worktree;
 *   2. thread credentials — API key or subscription/OAuth token (see EngineAuth);
 *   3. pin an ISOLATED agent home — CLAUDE_CONFIG_DIR / CODEX_HOME under Atlas's own root, NEVER the
 *      developer's personal ~/.claude / ~/.codex;
 *   4. return { result, sessionId?, planText?, usage? }.
 *
 * Dropped vs v1: skills loader, MCP, persona/home materializer, effort, AskUserQuestion relay, the
 * agent-tools provisioner. The ESM-only SDKs arrive via lazy DI tokens (AtlasEsmModule). Zero v1
 * imports.
 */

// Claude built-in tool sets. `tools` RESTRICTS the available set (unlike `allowedTools`, which only
// auto-approves). A focused file+shell worker: no WebSearch/Agent/MCP.
const WORKER_TOOLS = ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash'];
// A plan turn adds ExitPlanMode — native plan mode's turn-ender and the one place the FULL plan text
// reaches canUseTool headlessly (the CLI auto-writes the plan file, then calls ExitPlanMode with the
// plan in its input).
const PLAN_TOOLS = [...WORKER_TOOLS, 'ExitPlanMode'];
// A read-only review turn gets the read tools only.
const REVIEW_TOOLS = ['Read', 'Glob', 'Grep', 'Bash'];
// The STRICTEST read-only posture (scoping/grilling over a shared clone): NO Bash at all, so there is
// no write vector — Write/Edit are denied by canUseTool, and with Bash absent nothing can mutate the
// tree. Read/Glob/Grep is plenty to investigate stack/structure/conventions/tooling.
const INVESTIGATE_TOOLS = ['Read', 'Glob', 'Grep'];
// Auto-approve safe reads; writes/bash fall through to canUseTool where the boundary is re-applied.
const AUTO_APPROVE = ['Read', 'Glob', 'Grep'];

/** Is `path` inside `root` (after resolution)? Confines writes to the worktree. */
function isInsideRoot(path: string, root: string): boolean {
  const r = resolvePath(root);
  const p = resolvePath(root, path);
  return p === r || p.startsWith(r.endsWith('/') ? r : `${r}/`);
}

/** The repo's SHARED git dir for `cwd` — for a linked worktree `.git` lives OUTSIDE cwd, so Codex's
 * workspace-write sandbox must be granted it explicitly or commit/push fail. undefined off-repo. */
function gitCommonDir(cwd: string): string | undefined {
  try {
    return (
      execFileSync(
        'git',
        ['rev-parse', '--path-format=absolute', '--git-common-dir'],
        { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim() || undefined
    );
  } catch {
    return undefined;
  }
}

@Injectable()
export class EngineRunner {
  private readonly logger = new Logger(EngineRunner.name);
  // One Codex client per (auth, sandbox) — each funds its own runs from its own home.
  private readonly codexClients = new Map<string, Codex>();

  constructor(
    @Inject(ATLAS_ANTHROPIC_SDK)
    private readonly claudeSdk: typeof import('@anthropic-ai/claude-agent-sdk'),
    @Inject(ATLAS_CODEX_SDK)
    private readonly codexSdk: typeof import('@openai/codex-sdk'),
    private readonly env: EnvService,
  ) {}

  /** The Atlas agent-home root — ATLAS_AGENT_HOME_ROOT, else v1's AGENT_HOME_ROOT, else the default. */
  private homeRoot(): string | undefined {
    return this.env.get('ATLAS_AGENT_HOME_ROOT') ?? this.env.get('AGENT_HOME_ROOT');
  }

  /**
   * Resolve the run's auth: an explicit `args.auth` (the per-tenant value the driver now passes from
   * `CredentialResolver.engineAuth(job.teamId)`) wins; otherwise derive from env via the SHARED helper
   * the resolver also uses — so the runner's env path and the resolver's env fallback can never drift.
   */
  private resolveAuth(
    engine: 'claude' | 'codex',
    explicit: EngineAuth | undefined,
  ): EngineAuth {
    if (explicit) return explicit;
    return engineAuthFromEnv(this.env, engine, (m) => this.logger.warn(m));
  }

  async run(args: RunEngineArgs): Promise<EngineRunResult> {
    return args.engine === 'codex' ? this.runCodex(args) : this.runClaude(args);
  }

  // ── Claude ────────────────────────────────────────────────────────────────────────────────────

  private async runClaude(args: RunEngineArgs): Promise<EngineRunResult> {
    const {
      task,
      cwd,
      systemPrompt,
      sandboxKey,
      sessionId,
      mode,
      onEvent,
      signal,
    } = args;

    const abortController = new AbortController();
    if (signal) {
      if (signal.aborted) abortController.abort();
      else signal.addEventListener('abort', () => abortController.abort(), { once: true });
    }

    const auth = this.resolveAuth('claude', args.auth);
    const model = args.model ?? this.env.get('ATLAS_WORKER_MODEL') ?? this.env.get('WORKER_MODEL');

    // Pin the SDK subprocess to Atlas's ISOLATED config/state home — never ~/.claude.
    const claudeConfigDir = atlasEngineHomeDir(this.homeRoot(), 'claude', sandboxKey);
    const planMode = mode === 'plan';
    const readOnly = mode !== 'execute';

    let capturedPlan = '';
    const subprocessEnv: Record<string, string | undefined> = {
      ...process.env,
      CLAUDE_CONFIG_DIR: claudeConfigDir,
    };
    applyClaudeAuth(subprocessEnv, auth);

    const options: Options = {
      cwd,
      systemPrompt,
      // No skills: settingSources [] means NO on-disk config files are read (full isolation).
      settingSources: [],
      tools: planMode
        ? PLAN_TOOLS
        : mode === 'investigate'
          ? INVESTIGATE_TOOLS
          : readOnly
            ? REVIEW_TOOLS
            : WORKER_TOOLS,
      allowedTools: AUTO_APPROVE,
      canUseTool: makeCanUseTool(readOnly, cwd, (plan) => {
        capturedPlan = plan;
      }),
      permissionMode: planMode ? 'plan' : 'default',
      // Suppress the SDK's default "Co-Authored-By: Claude" attribution.
      settings: { attribution: { commit: '', pr: '' } },
      abortController,
      env: subprocessEnv,
      ...(sessionId ? { resume: sessionId } : {}),
      ...(model ? { model } : {}),
    };

    let result = '';
    let resolvedSession = sessionId;
    let usage: EngineUsage | undefined;
    for await (const message of this.claudeSdk.query({ prompt: task, options })) {
      if (message.type === 'system' && message.subtype === 'init') {
        resolvedSession = message.session_id;
      } else if (message.type === 'assistant') {
        for (const block of message.message.content as Array<{
          type: string;
          text?: string;
          name?: string;
        }>) {
          if (block.type === 'text' && block.text) onEvent?.({ kind: 'text', text: block.text });
          else if (block.type === 'tool_use' && block.name)
            onEvent?.({ kind: 'tool', name: block.name });
        }
      } else if (message.type === 'result') {
        resolvedSession = message.session_id;
        if (message.subtype === 'success') {
          result = message.result;
          usage = extractClaudeUsage(message as Record<string, unknown>, model);
        } else {
          throw new Error(`Claude engine ended: ${message.subtype}`);
        }
      }
    }

    // On a plan turn the substance is the captured plan, not the closing summary.
    const planText = (planMode && capturedPlan) || undefined;
    const summary = planText || result || '(no summary)';
    onEvent?.({ kind: 'result', text: summary });
    return {
      result: summary,
      sessionId: resolvedSession,
      ...(planText ? { planText } : {}),
      ...(usage ? { usage } : {}),
    };
  }

  // ── Codex ─────────────────────────────────────────────────────────────────────────────────────

  private getCodex(sandboxKey: string, auth: EngineAuth): Codex {
    const root = this.homeRoot();
    const subscription = auth.mode === 'subscription' ? auth : undefined;
    const apiKey = auth.mode === 'api_key' ? auth.apiKey : undefined;
    // SUBSCRIPTION: an overlay home owning its own auth.json (refreshed each turn). API-KEY: the plain
    // isolated home with the key passed to the SDK. The cache key keeps two auths/sandboxes apart.
    const codexHome = subscription
      ? ensureCodexAuthHome(root, sandboxKey, subscription.secret)
      : atlasEngineHomeDir(root, 'codex', sandboxKey);
    const cacheKey = subscription
      ? `sub:${sandboxKey}`
      : `${apiKey ?? 'ambient'}:${sandboxKey}`;
    let client = this.codexClients.get(cacheKey);
    if (!client) {
      // The SDK's `env` REPLACES inheritance — pass process.env through and override CODEX_HOME.
      // Subscription mode passes NO apiKey → the CLI reads auth.json from CODEX_HOME instead.
      const env = { ...process.env, CODEX_HOME: codexHome } as Record<string, string>;
      client = subscription
        ? new this.codexSdk.Codex({ env })
        : new this.codexSdk.Codex(apiKey ? { apiKey, env } : { env });
      this.codexClients.set(cacheKey, client);
    }
    return client;
  }

  private codexThreadOptions(cwd: string, model: string | undefined, readOnly: boolean): ThreadOptions {
    // Grant write access to the shared git dir (outside cwd in a linked worktree) so an execute turn
    // can commit/push. Not needed on a read-only turn.
    const gitDir = readOnly ? undefined : gitCommonDir(cwd);
    return {
      workingDirectory: cwd,
      // Codex's read-only sandbox is how BOTH read-only modes (plan, review) are enforced; execute
      // gets workspace-write (writes confined to the worktree).
      sandboxMode: readOnly ? 'read-only' : 'workspace-write',
      approvalPolicy: 'never',
      skipGitRepoCheck: true,
      webSearchMode: 'live',
      ...(gitDir ? { additionalDirectories: [gitDir] } : {}),
      ...(model ? { model } : {}),
    };
  }

  private async runCodex(args: RunEngineArgs): Promise<EngineRunResult> {
    const { task, cwd, systemPrompt, sandboxKey, sessionId, mode, onEvent, signal } = args;
    const auth = this.resolveAuth('codex', args.auth);
    const model = args.model ?? this.env.get('ATLAS_CODEX_MODEL') ?? this.env.get('CODEX_MODEL');
    const readOnly = mode !== 'execute';

    const client = this.getCodex(sandboxKey, auth);
    const opts = this.codexThreadOptions(cwd, model, readOnly);
    const thread = sessionId ? client.resumeThread(sessionId, opts) : client.startThread(opts);

    // Codex has no systemPrompt option — seed the persona as a first-turn preamble. Resumes already
    // carry it in thread history.
    const input = sessionId ? task : `${systemPrompt}\n\n---\n\nTask: ${task}`;

    let result = '';
    let resolvedSession = sessionId;
    let accInput = 0;
    let accCached = 0;
    let accOutput = 0;
    let accReasoning = 0;
    let usageSeen = false;

    const { events } = await thread.runStreamed(input, { signal });
    for await (const event of events) {
      switch (event.type) {
        case 'thread.started':
          resolvedSession = event.thread_id;
          break;
        case 'item.completed': {
          const item = event.item;
          switch (item.type) {
            case 'agent_message':
              onEvent?.({ kind: 'text', text: item.text });
              result = item.text;
              break;
            case 'reasoning':
              onEvent?.({ kind: 'text', text: item.text });
              break;
            case 'command_execution':
              onEvent?.({ kind: 'tool', name: 'bash', detail: item.command });
              break;
            case 'file_change':
              onEvent?.({
                kind: 'tool',
                name: 'edit',
                detail: item.changes.map((c) => `${c.kind} ${c.path}`).join(', '),
              });
              break;
            case 'web_search':
              onEvent?.({ kind: 'tool', name: 'web_search', detail: item.query });
              break;
            case 'error':
              onEvent?.({ kind: 'text', text: `error: ${item.message}` });
              break;
          }
          break;
        }
        case 'turn.completed': {
          const u = event.usage;
          accInput += u.input_tokens ?? 0;
          accCached += u.cached_input_tokens ?? 0;
          accOutput += u.output_tokens ?? 0;
          accReasoning += u.reasoning_output_tokens ?? 0;
          usageSeen = true;
          break;
        }
        case 'turn.failed':
          throw new Error(event.error.message);
        case 'error':
          throw new Error(event.message);
      }
    }

    const summary = result || '(no summary)';
    onEvent?.({ kind: 'result', text: summary });

    const usage: EngineUsage | undefined = usageSeen
      ? {
          inputTokens: accInput,
          outputTokens: accOutput,
          ...(accCached > 0 ? { cacheReadTokens: accCached } : {}),
          ...(accReasoning > 0 ? { reasoningTokens: accReasoning } : {}),
          ...(model ? { model } : {}),
        }
      : undefined;

    return {
      result: summary,
      sessionId: resolvedSession ?? thread.id ?? undefined,
      ...(usage ? { usage } : {}),
    };
  }
}

/** Re-applies the safety boundary to Claude's built-in tools (programmatic gate — never blocks on a
 * human). A 'plan' turn runs under the SDK's native plan mode (the CLI itself enforces read-only);
 * ExitPlanMode's input carries the plan, which we capture then DENY (approving would flip the live
 * session into execution). The Write/Edit/bash read-only branches are belt-and-braces. */
function makeCanUseTool(
  readOnly: boolean,
  root: string,
  onPlan: (plan: string) => void,
): CanUseTool {
  return async (toolName, input): Promise<PermissionResult> => {
    if (toolName === 'ExitPlanMode') {
      if (typeof input.plan === 'string') onPlan(input.plan);
      return { behavior: 'deny', message: 'Plan recorded — ending the planning turn.' };
    }
    if (readOnly && (toolName === 'Write' || toolName === 'Edit')) {
      return { behavior: 'deny', message: 'This is a read-only turn — no file writes.' };
    }
    if (toolName === 'Write' || toolName === 'Edit') {
      const path = typeof input.file_path === 'string' ? input.file_path : '';
      if (path && !isInsideRoot(path, root)) {
        return { behavior: 'deny', message: `Write outside the worktree is not allowed: ${path}` };
      }
    }
    return { behavior: 'allow', updatedInput: input };
  };
}

/** Extract token usage from a Claude success result. Convention: inputTokens = total INCLUDING cache. */
function extractClaudeUsage(
  message: Record<string, unknown>,
  model: string | undefined,
): EngineUsage | undefined {
  const u = message.usage as
    | {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      }
    | undefined;
  if (!u) return undefined;
  const costUsd = message.total_cost_usd as number | undefined;
  const modelUsage = message.modelUsage as Record<string, unknown> | undefined;
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  const inputTokens = (u.input_tokens ?? 0) + cacheRead + cacheWrite;
  const usedModel = (modelUsage ? Object.keys(modelUsage)[0] : undefined) ?? model;
  return {
    inputTokens,
    ...(u.output_tokens !== undefined ? { outputTokens: u.output_tokens } : {}),
    ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(usedModel ? { model: usedModel } : {}),
  };
}
