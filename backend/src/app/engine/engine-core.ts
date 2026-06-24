import type { CanUseTool, Options, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { Codex, ThreadOptions } from '@openai/codex-sdk';
import { execFileSync } from 'node:child_process';
import { resolve as resolvePath } from 'node:path';
import { applyClaudeAuth } from './claude-auth';
import { atlasEngineHomeDir } from './engine-home';
import { ensureCodexAuthHome } from './codex-auth-home';
import {
  EngineAuthError,
  isAuthErrorMessage,
  type EngineAuth,
  type EngineRunResult,
  type EngineUsage,
  type RunEngineArgs,
} from './engine.types';

/**
 * The Atlas v2 ENGINE CORE — the vendor logic for running ONE Claude/Codex turn, with **zero Nest and
 * zero @core dependencies**. It is the single implementation shared by two callers:
 *   - the in-process Nest `EngineRunner` (host-local execution), and
 *   - the in-container engine entrypoint (`image/engine-entrypoint.ts`), bundled into the sandbox
 *     image and invoked via `docker exec` — so a turn behaves IDENTICALLY on the host and in a sandbox.
 *
 * It does exactly four things: plan/review (read-only) vs execute (writes confined to the worktree);
 * thread credentials (api_key | subscription); pin an ISOLATED agent home (CLAUDE_CONFIG_DIR/CODEX_HOME,
 * never the personal one); return { result, sessionId?, planText?, usage? }. Env-derived knobs arrive as
 * an {@link EngineCoreConfig} (read from `EnvService` on the host, from `process.env` in the container),
 * and logging goes through a tiny {@link CoreLogger} (Nest Logger on the host, console in the container).
 */

/** Env-derived configuration (the values the host reads from EnvService, the container from process.env). */
export interface EngineCoreConfig {
  /** Root for the isolated agent home (AGENT_HOME_ROOT ?? AGENT_HOME_ROOT). */
  homeRoot?: string;
  /** Default auth mode when a run doesn't pass explicit `auth` (ENGINE_AUTH_MODE). */
  authMode?: 'api_key' | 'subscription';
  /** Subscription OAuth token for Claude (CLAUDE_OAUTH_TOKEN). */
  claudeOauthToken?: string;
  /** Fallback Anthropic API key (ANTHROPIC_API_KEY). */
  anthropicApiKey?: string;
  /** Default Claude model (WORKER_MODEL ?? WORKER_MODEL). */
  workerModel?: string;
  /** Default Codex model (CODEX_MODEL ?? CODEX_MODEL). */
  codexModel?: string;
}

/** A minimal logger so the core stays Nest-free. */
export interface CoreLogger {
  warn(message: string): void;
}

const NOOP_LOGGER: CoreLogger = { warn: () => undefined };

// Claude built-in tool sets. `tools` RESTRICTS the available set (unlike `allowedTools`, which only
// auto-approves). A focused file+shell worker: no WebSearch/Agent/MCP.
const WORKER_TOOLS = ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash'];
// A plan turn adds ExitPlanMode — native plan mode's turn-ender and the one place the FULL plan text
// reaches canUseTool headlessly (the CLI auto-writes the plan file, then calls ExitPlanMode with the
// plan in its input).
const PLAN_TOOLS = [...WORKER_TOOLS, 'ExitPlanMode'];
// A read-only review turn gets the read tools only.
const REVIEW_TOOLS = ['Read', 'Glob', 'Grep', 'Bash'];
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
      execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || undefined
    );
  } catch {
    return undefined;
  }
}

export class EngineCore {
  // One Codex client per (auth, sandbox) — each funds its own runs from its own home.
  private readonly codexClients = new Map<string, Codex>();

  constructor(
    private readonly claudeSdk: typeof import('@anthropic-ai/claude-agent-sdk'),
    private readonly codexSdk: typeof import('@openai/codex-sdk'),
    private readonly cfg: EngineCoreConfig,
    private readonly logger: CoreLogger = NOOP_LOGGER,
  ) {}

  private homeRoot(): string | undefined {
    return this.cfg.homeRoot;
  }

  /** Resolve the run's auth: an explicit `args.auth` wins; otherwise derive from config. */
  private resolveAuth(engine: 'claude' | 'codex', explicit: EngineAuth | undefined): EngineAuth {
    if (explicit) return explicit;
    const mode = this.cfg.authMode ?? 'api_key';
    if (mode === 'subscription') {
      if (engine === 'claude') {
        const secret = this.cfg.claudeOauthToken;
        if (secret) return { mode: 'subscription', secret };
        this.logger.warn(
          'ENGINE_AUTH_MODE=subscription but CLAUDE_OAUTH_TOKEN unset — falling back to api_key',
        );
      }
      // Codex subscription needs an auth.json overlay that isn't env-configured here → api_key.
    }
    return { mode: 'api_key', ...(this.cfg.anthropicApiKey ? { apiKey: this.cfg.anthropicApiKey } : {}) };
  }

  async run(args: RunEngineArgs): Promise<EngineRunResult> {
    return args.engine === 'codex' ? this.runCodex(args) : this.runClaude(args);
  }

  /**
   * Like `run`, but passes extra Claude SDK options (e.g. `mcpServers` for the tool bridge).
   * Used by the in-container entrypoint when the tool-bridge is active; the host `EngineRunner`
   * calls the plain `run` path (the bridge is wired host-side there).
   */
  async runWithExtras(
    args: RunEngineArgs,
    extraClaudeOptions?: Record<string, unknown>,
  ): Promise<EngineRunResult> {
    return args.engine === 'codex'
      ? this.runCodex(args)
      : this.runClaude(args, extraClaudeOptions);
  }

  // ── Claude ────────────────────────────────────────────────────────────────────────────────────

  private async runClaude(
    args: RunEngineArgs,
    extraClaudeOptions?: Record<string, unknown>,
  ): Promise<EngineRunResult> {
    const { task, cwd, systemPrompt, sandboxKey, sessionId, mode, onEvent, signal } = args;

    const abortController = new AbortController();
    if (signal) {
      if (signal.aborted) abortController.abort();
      else signal.addEventListener('abort', () => abortController.abort(), { once: true });
    }

    const auth = this.resolveAuth('claude', args.auth);
    const model = args.model ?? this.cfg.workerModel;

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
      tools: planMode ? PLAN_TOOLS : readOnly ? REVIEW_TOOLS : WORKER_TOOLS,
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
      // R1 tool-bridge: optional extra options (e.g. mcpServers) from the in-container entrypoint.
      ...(extraClaudeOptions ?? {}),
    } as Options;

    let result = '';
    let resolvedSession = sessionId;
    let usage: EngineUsage | undefined;
    try {
      for await (const message of this.claudeSdk.query({ prompt: task, options })) {
        if (message.type === 'system' && message.subtype === 'init') {
          resolvedSession = message.session_id;
          // Surface the resume handle the instant the session exists, so a mid-turn halt is recoverable.
          if (resolvedSession) onEvent?.({ kind: 'session', sessionId: resolvedSession });
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
    } catch (err) {
      // A 401 / expired token / "not logged in" → a RESUMABLE auth error carrying the live session,
      // so the driver pauses (not fails) and a re-ping continues this same session. Else re-throw.
      const msg = err instanceof Error ? err.message : String(err);
      if (isAuthErrorMessage(msg)) throw new EngineAuthError(msg, resolvedSession);
      throw err;
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
    const cacheKey = subscription ? `sub:${sandboxKey}` : `${apiKey ?? 'ambient'}:${sandboxKey}`;
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

  private codexThreadOptions(
    cwd: string,
    model: string | undefined,
    readOnly: boolean,
  ): ThreadOptions {
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
    const model = args.model ?? this.cfg.codexModel;
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
    try {
      for await (const event of events) {
      switch (event.type) {
        case 'thread.started':
          resolvedSession = event.thread_id;
          // Surface the resume handle immediately (turn start) for mid-turn halt recovery.
          if (resolvedSession) onEvent?.({ kind: 'session', sessionId: resolvedSession });
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
    } catch (err) {
      // 401 / expired creds mid-Codex-turn → resumable auth error carrying the live thread id.
      const msg = err instanceof Error ? err.message : String(err);
      if (isAuthErrorMessage(msg)) throw new EngineAuthError(msg, resolvedSession);
      throw err;
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
export function makeCanUseTool(
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
export function extractClaudeUsage(
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
