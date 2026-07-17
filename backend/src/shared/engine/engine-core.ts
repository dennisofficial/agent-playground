import type { Codex, FileChangeItem, ThreadOptions } from '@openai/codex-sdk';
import type {
  AdapterRunArgs,
  ContextBreakdown,
  EngineCapability,
  EngineLocalHooks,
} from '@workspace/agent-engine';
import {
  buildEngineLocalHooks,
  CodexAppServerAdapter,
  guardHooksAgainstCapabilities,
} from '@workspace/agent-engine';
import { structuredPatch as diffStructuredPatch } from 'diff';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve as resolvePath } from 'node:path';
import {
  BG_TASK_HOLD_CAP_MS,
  bgTaskCapRule,
  detectGithubHtmlUrl,
  detectLongRunningCommand,
  legRotationRule,
  renderGithubFetchNudge,
  ROTATION_REMINDER_DELTA_TOKENS,
  ROTATION_SOFT_TOKENS,
  SVC_NUDGE_TEXT,
  svcNudgeRule,
  svcNudgeShouldFire,
} from '../prompt-kit/jit';
import { ClaudeAdapter } from './claude-adapter';
import {
  ensureCodexAuthHome,
  type CodexExtraMcpServers,
  type CodexMcpBridge,
} from './codex-auth-home';
import { BackendCodexHomeProvisioner } from './codex-home-provisioner';
import { getEngineAuthAdapter } from './engine-auth-adapter';
import { EngineAuthResolver } from './engine-core/auth-resolver';
import { BackgroundHoldTimer } from './engine-core/background-hold-timer';
import { buildClaudeOptions } from './engine-core/claude-options-builder';
import { normalizeContextBreakdown } from './engine-core/context-breakdown';
import { composeSkillsDir } from './engine-core/skills-composer';
import { SteerInputChannel } from './engine-core/steer-input-channel';
import { addClaudeUsage, extractClaudeUsage, toCodexEffort } from './engine-core/usage';
import { atlasEngineHomeDir, engineHomeKeyString, type EngineHomeKey } from './engine-home';
import {
  EngineAuthError,
  isAuthErrorMessage,
  resolveContextLimit,
  UNRESUMABLE_SESSION_MARKER,
  type CodexReasoningEffort,
  type EngineAuth,
  type EngineRunResult,
  type EngineUsage,
  type RunEngineArgs,
  type StructuredPatchHunk,
} from './engine.types';
import {
  detectSessionLimitText,
  limitFromRateEvent,
  textSessionLimitHit,
  type SessionLimitHit,
} from './session-limit';

const CONTAINER_MCP_BRIDGE_PATH = '/usr/local/lib/atlas/mcp-bridge-server.mjs';

const requireFromHere = createRequire(__filename);

function extractStructuredPatch(toolUseResult: unknown): StructuredPatchHunk[] | undefined {
  if (!toolUseResult || typeof toolUseResult !== 'object') return undefined;
  const raw = (toolUseResult as { structuredPatch?: unknown }).structuredPatch;
  if (!Array.isArray(raw)) return undefined;
  const hunks: StructuredPatchHunk[] = [];
  for (const h of raw) {
    if (!h || typeof h !== 'object') continue;
    const r = h as Record<string, unknown>;
    if (!Array.isArray(r.lines)) continue;
    const num = (v: unknown, fallback: number): number => (typeof v === 'number' ? v : fallback);
    hunks.push({
      oldStart: num(r.oldStart, 1),
      oldLines: num(r.oldLines, 0),
      newStart: num(r.newStart, 1),
      newLines: num(r.newLines, 0),
      lines: (r.lines as unknown[]).map(String),
    });
  }
  return hunks.length ? hunks : undefined;
}

function containsStreamClosed(content: unknown): boolean {
  if (typeof content === 'string') return content.toLowerCase().includes('stream closed');
  if (Array.isArray(content)) return content.some((item) => containsStreamClosed(item));
  if (!content || typeof content !== 'object') return false;
  const block = content as { text?: unknown; content?: unknown };
  return containsStreamClosed(block.text) || containsStreamClosed(block.content);
}

function computeCodexStructuredPatch(
  cwd: string,
  path: string,
  kind: FileChangeItem['changes'][number]['kind'],
): StructuredPatchHunk[] | undefined {
  let oldContent = '';
  if (kind !== 'add') {
    try {
      oldContent = execFileSync('git', ['show', `HEAD:${path}`], {
        cwd,
        encoding: 'utf8',
      });
    } catch {
      oldContent = '';
    }
  }
  let newContent = '';
  if (kind !== 'delete') {
    try {
      const abs = resolvePath(cwd, path);
      newContent = existsSync(abs) ? readFileSync(abs, 'utf8') : '';
    } catch {
      newContent = '';
    }
  }
  if (!oldContent && !newContent) return undefined;
  const patch = diffStructuredPatch(path, path, oldContent, newContent, undefined, undefined, {
    context: 3,
  });
  return patch.hunks.length ? patch.hunks : undefined;
}

export { detectLongRunningCommand, SVC_NUDGE_TEXT, svcNudgeShouldFire };
export { detectGithubHtmlUrl, renderGithubFetchNudge };

function isTurnGenuinelyDone(m: {
  terminal_reason?: string;
  stop_reason?: string | null;
}): boolean {
  if (m.terminal_reason === 'completed') return true;
  if (m.terminal_reason == null && m.stop_reason === 'end_turn') return true;
  return false;
}

export { toClaudeEffort, toCodexEffort } from './engine-core/usage';


export interface EngineCoreConfig {
  homeRoot?: string;
  skillsRoot?: string;
  managedSkillsRoot?: string;
  managedGitSkillsRoot?: string;
}

const DEFAULT_WORKER_MODEL = 'claude-sonnet-5';
const CONTEXT_BREAKDOWN_AUTHORITATIVE_TIMEOUT_MS = 5_000;

export function claudeSessionExists(configDir: string, sessionId: string): boolean {
  const projects = join(configDir, 'projects');
  let dirs: string[];
  try {
    dirs = readdirSync(projects);
  } catch {
    return false; // no projects dir yet → nothing to resume
  }
  return dirs.some((d) => existsSync(join(projects, d, `${sessionId}.jsonl`)));
}

export { applyPerRunCtxToAgents } from './engine-core/agents-registry';

export { composeSkillsDir } from './engine-core/skills-composer';

export { makeCanUseTool } from './engine-core/tool-permission';
export type { SkillGuardCtx } from './engine-core/tool-permission';

export class EngineCore {
  private readonly codexClients = new Map<string, Codex>();
  private readonly authResolver = new EngineAuthResolver();

  constructor(
    private readonly claudeSdk: typeof import('@anthropic-ai/claude-agent-sdk'),
    private readonly codexSdk: typeof import('@openai/codex-sdk'),
    private readonly cfg: EngineCoreConfig,
  ) {}

  private homeRoot(): string | undefined {
    return this.cfg.homeRoot;
  }

  private skillsRoot(): string | undefined {
    return this.cfg.skillsRoot;
  }

  private managedSkillsRoot(): string | undefined {
    return this.cfg.managedSkillsRoot;
  }

  private managedGitSkillsRoot(): string | undefined {
    return this.cfg.managedGitSkillsRoot;
  }

  private resolveAuth(engine: 'claude' | 'codex', explicit: EngineAuth | undefined): EngineAuth {
    return this.authResolver.resolve(engine, explicit);
  }

  async run(args: RunEngineArgs): Promise<EngineRunResult> {
    const appserver = args.engine === 'codex' && this.codexAppServerEnabled();
    return this.stampUsageProvenance(
      await (args.engine === 'codex'
        ? appserver
          ? this.runCodexAppServer(args)
          : this.runCodex(args)
        : new ClaudeAdapter(this.runClaude.bind(this), args).run(this.toAdapterArgs(args))),
      args,
      appserver,
    );
  }

  private toAdapterArgs(
    args: RunEngineArgs,
    authOverride?: EngineAuth,
    hooks?: EngineLocalHooks,
  ): AdapterRunArgs {
    return {
      engine: args.engine,
      task: args.task,
      cwd: args.cwd,
      systemPrompt: args.systemPrompt,
      mode: args.mode,
      sandboxKey: args.sandboxKey,
      ...(args.sessionId ? { sessionId: args.sessionId } : {}),
      ...(authOverride ? { auth: authOverride } : args.auth ? { auth: args.auth } : {}),
      ...(args.model ? { model: args.model } : {}),
      ...(args.modelReasoningEffort ? { modelReasoningEffort: args.modelReasoningEffort } : {}),
      ...(args.writableRoots ? { writableRoots: args.writableRoots } : {}),
      ...(args.richStream !== undefined ? { richStream: args.richStream } : {}),
      ...(args.persistAuthRefresh !== undefined
        ? { persistAuthRefresh: args.persistAuthRefresh }
        : {}),
      ...(args.signal ? { signal: args.signal } : {}),
      ...(args.onEvent ? { onEvent: args.onEvent } : {}),
      ...(hooks ? { hooks } : {}),
    };
  }

  private buildCodexHooks(
    args: RunEngineArgs,
    capabilities: ReadonlySet<EngineCapability>,
  ): EngineLocalHooks {
    const readOnly = args.mode !== 'execute';
    const hooks = buildEngineLocalHooks({
      svcNudge: svcNudgeRule.enabled
        ? {
            tool: 'Bash',
            match: detectLongRunningCommand,
            deltaTokens: svcNudgeRule.throttle!.deltaTokens,
            render: (command) => svcNudgeRule.render({ command }),
          }
        : undefined,
      writeGuard: {
        readOnly,
        roots: [args.cwd, ...(args.writableRoots ?? [])],
      },
      rotation: legRotationRule.enabled
        ? {
            softTokens: ROTATION_SOFT_TOKENS,
            reminderDeltaTokens: ROTATION_REMINDER_DELTA_TOKENS,
            softText: legRotationRule.render({ phase: 'soft' }),
            reminderText: legRotationRule.render({ phase: 'reminder' }),
          }
        : undefined,
    });
    return guardHooksAgainstCapabilities(hooks, capabilities);
  }

  private codexAppServerEnabled(): boolean {
    return (
      process.env.CODEX_APPSERVER_ENABLED === 'true' || process.env.CODEX_APPSERVER_ENABLED === '1'
    );
  }

  private codexAppServerSpawnOptions(): {
    codexPathOverride?: string;
    args?: string[];
  } {
    try {
      const codexBin = requireFromHere.resolve('@openai/codex/bin/codex.js');
      return {
        codexPathOverride: process.execPath,
        args: [codexBin, 'app-server'],
      };
    } catch {
      return {};
    }
  }

  private async runCodexAppServer(args: RunEngineArgs): Promise<EngineRunResult> {
    const auth = this.resolveAuth('codex', args.auth);
    const adapter = new CodexAppServerAdapter(
      new BackendCodexHomeProvisioner(this.homeRoot()),
      this.codexAppServerSpawnOptions(),
    );
    return adapter.run(
      this.toAdapterArgs(args, auth, this.buildCodexHooks(args, adapter.capabilities)),
    );
  }

  private stampUsageProvenance(
    res: EngineRunResult,
    args: RunEngineArgs,
    appserver?: boolean,
  ): EngineRunResult {
    if (res.usage) {
      res.usage.engine ??= args.engine;
      if (args.modelReasoningEffort) res.usage.reasoningEffort ??= args.modelReasoningEffort;
      if (args.engine === 'codex') res.usage.appserver ??= !!appserver;
    }
    return res;
  }

  async runWithExtras(
    args: RunEngineArgs,
    extraClaudeOptions?: Record<string, unknown>,
    bridgeToolNames?: string[],
    codexBridgeTools?: string[],
    codexExtraMcpServers?: CodexExtraMcpServers,
  ): Promise<EngineRunResult> {
    const hasCodexBridgeExtras =
      (codexBridgeTools?.length ?? 0) > 0 || Object.keys(codexExtraMcpServers ?? {}).length > 0;
    const appserver =
      args.engine === 'codex' && this.codexAppServerEnabled() && !hasCodexBridgeExtras;
    return this.stampUsageProvenance(
      await (args.engine === 'codex'
        ? appserver
          ? this.runCodexAppServer(args)
          : this.runCodex(args, codexBridgeTools, codexExtraMcpServers)
        : new ClaudeAdapter(
            this.runClaude.bind(this),
            args,
            extraClaudeOptions,
            bridgeToolNames,
          ).run(this.toAdapterArgs(args))),
      args,
      appserver,
    );
  }


  private async runClaude(
    args: RunEngineArgs,
    extraClaudeOptions?: Record<string, unknown>,
    bridgeToolNames?: string[],
    hooks?: EngineLocalHooks,
  ): Promise<EngineRunResult> {
    const {
      task,
      cwd,
      systemPrompt,
      sandboxKey,
      sessionId,
      mode,
      onEvent,
      signal,
      richStream,
      steerInput,
      rotationNudge,
      bridgeCall,
    } = args;

    const abortController = new AbortController();
    if (signal) {
      if (signal.aborted) abortController.abort();
      else
        signal.addEventListener('abort', () => abortController.abort(), {
          once: true,
        });
    }

    const channel = new SteerInputChannel(steerInput, task, hooks, onEvent);
    const streaming = channel.streaming;

    const STREAM_CLOSED_THRESHOLD =
      Number(process.env.ENGINE_STREAM_CLOSED_THRESHOLD) > 0
        ? Number(process.env.ENGINE_STREAM_CLOSED_THRESHOLD)
        : 3; // consecutive control-channel failures ⇒ breaker trips
    let streamClosedRun = 0; // consecutive "Stream closed" tool_results in the live run (any healthy result resets)
    let streamClosedTotal = 0; // per-turn total (instrumentation)
    let streamClosedTripped = false; // latched right before the breaker throw so the catch never swallows it as a cooperative abort
    let firedNudgeLevel = -1;

    const HOLD_CAP_MS =
      bgTaskCapRule.trigger.kind === 'hold-timer'
        ? bgTaskCapRule.trigger.holdMs
        : BG_TASK_HOLD_CAP_MS;
    const holdTimer = new BackgroundHoldTimer({
      holdCapMs: HOLD_CAP_MS,
      streaming,
      isTurnEnded: () => channel.turnEnded,
      cancelEnd: () => channel.cancelEnd(),
      onEvent,
      steer: hooks?.steer,
    });

    const auth = this.resolveAuth('claude', args.auth);
    const model = args.model ?? DEFAULT_WORKER_MODEL;

    const claudeConfigDir = atlasEngineHomeDir(this.homeRoot(), 'claude', sandboxKey);

    if (sessionId && !claudeSessionExists(claudeConfigDir, sessionId)) {
      throw new Error(
        `${UNRESUMABLE_SESSION_MARKER}: engine session ${sessionId} not found under ${claudeConfigDir} — cannot resume`,
      );
    }

    const planMode = mode === 'plan';
    const readOnly = mode !== 'execute';

    let capturedPlan = '';
    const subprocessEnv: Record<string, string | undefined> = {
      ...process.env,
      CLAUDE_CONFIG_DIR: claudeConfigDir,
      CLAUDE_CODE_MAX_RETRIES: process.env.CLAUDE_CODE_MAX_RETRIES ?? '10',
    };
    getEngineAuthAdapter('claude').materialize({
      homeRoot: this.homeRoot(),
      key: sandboxKey,
      secret: auth.secret,
      kind: auth.kind,
      env: subprocessEnv,
    });

    const stderrTail: string[] = [];
    const captureStderr = (data: string) => {
      stderrTail.push(data);
      if (stderrTail.length > 40) stderrTail.shift(); // keep the last ~40 chunks
    };

    composeSkillsDir(
      claudeConfigDir,
      args.skills,
      this.skillsRoot(),
      this.managedSkillsRoot(),
      this.managedGitSkillsRoot(),
    );

    let contextTokens: number | undefined;
    let contextModel: string | undefined;
    let lastBreakdown: ContextBreakdown | undefined;
    let breakdownRequest: Promise<void> | undefined;
    let allowLiveBreakdownEvents = true;

    const options = buildClaudeOptions({
      cwd,
      systemPrompt,
      planMode,
      readOnly,
      mode,
      args,
      bridgeToolNames,
      claudeConfigDir,
      skillsStoreRoot: this.skillsRoot(),
      subprocessEnv,
      abortController,
      captureStderr,
      hooks,
      bridgeCall,
      extraClaudeOptions,
      sandboxKey,
      sessionId,
      model,
      richStream,
      setCapturedPlan: (plan) => {
        capturedPlan = plan;
      },
      getContextTokens: () => contextTokens,
      onJitInjection: (inj) =>
        onEvent?.({
          kind: 'jit_injection',
          id: inj.toolUseId,
          rule: inj.rule,
          text: inj.text,
        }),
    });

    let result = '';
    let resolvedSession = sessionId;
    let usage: EngineUsage | undefined;
    let sessionLimit: SessionLimitHit | undefined;
    try {
      const claudeQuery = this.claudeSdk.query({
        prompt: channel.prompt,
        options,
      });
      const waitForBreakdownRequest = async (
        request: Promise<void> | undefined,
      ): Promise<boolean> => {
        if (!request) return true;
        return new Promise<boolean>((resolve) => {
          const timeout = setTimeout(
            () => resolve(false),
            CONTEXT_BREAKDOWN_AUTHORITATIVE_TIMEOUT_MS,
          );
          void request.then(() => {
            clearTimeout(timeout);
            resolve(true);
          });
        });
      };
      const startBreakdownRequest = (emitLive: boolean): Promise<void> | undefined => {
        if (typeof claudeQuery.getContextUsage !== 'function') return undefined;
        const request = claudeQuery
          .getContextUsage()
          .then((raw) => {
            lastBreakdown = normalizeContextBreakdown(raw);
            if (emitLive && allowLiveBreakdownEvents) {
              onEvent?.({
                kind: 'context_breakdown',
                breakdown: lastBreakdown,
              });
            }
          })
          .catch(() => {
          })
          .finally(() => {
            if (breakdownRequest === request) breakdownRequest = undefined;
          });
        breakdownRequest = request;
        return request;
      };
      for await (const message of claudeQuery) {
        if (streaming && !holdTimer.capping && message.type !== 'result') channel.cancelEnd();
        if (message.type === 'system' && message.subtype === 'init') {
          resolvedSession = message.session_id;
          if (resolvedSession) onEvent?.({ kind: 'session', sessionId: resolvedSession });
        } else if (message.type === 'system' && message.subtype === 'task_started') {
          if (message.task_id) {
            holdTimer.trackTaskStarted(
              message.task_id,
              !!(message as { subagent_type?: string }).subagent_type,
            );
          }
          onEvent?.({
            kind: 'bg_task',
            taskId: message.task_id,
            status: 'started',
            detail: message.description,
            taskType: message.task_type,
            ...(message.tool_use_id ? { parentToolUseId: message.tool_use_id } : {}),
          });
        } else if (message.type === 'system' && message.subtype === 'task_notification') {
          onEvent?.({
            kind: 'bg_task',
            taskId: message.task_id,
            status: message.status,
            detail: message.summary,
            ...(message.tool_use_id ? { parentToolUseId: message.tool_use_id } : {}),
          });
          holdTimer.trackTaskSettled(message.task_id);
        } else if (message.type === 'system' && message.subtype === 'api_retry') {
          onEvent?.({
            kind: 'api_retry',
            attempt: message.attempt,
            maxRetries: message.max_retries,
            retryDelayMs: message.retry_delay_ms,
            errorStatus: message.error_status ?? null,
            reason: String(message.error),
          });
        } else if (message.type === 'rate_limit_event') {
          const info = message.rate_limit_info;
          onEvent?.({
            kind: 'rate_limit',
            status: info.status,
            ...(info.resetsAt != null ? { resetsAt: info.resetsAt } : {}),
            ...(info.rateLimitType ? { rateLimitType: info.rateLimitType } : {}),
            ...(info.utilization != null ? { utilization: info.utilization } : {}),
          });
          const hit = limitFromRateEvent(info);
          if (hit) sessionLimit = hit;
        } else if (richStream && message.type === 'stream_event') {
          const sev = message as {
            parent_tool_use_id?: string | null;
            event?: {
              type?: string;
              delta?: { type?: string; text?: string; thinking?: string };
            };
          };
          const parent = sev.parent_tool_use_id ?? undefined;
          const sub = parent ? { parentToolUseId: parent } : {};
          const ev = sev.event;
          if (ev?.type === 'content_block_delta') {
            if (ev.delta?.type === 'text_delta' && ev.delta.text)
              onEvent?.({ kind: 'text_delta', text: ev.delta.text, ...sub });
            else if (ev.delta?.type === 'thinking_delta' && ev.delta.thinking)
              onEvent?.({
                kind: 'thinking_delta',
                text: ev.delta.thinking,
                ...sub,
              });
          }
        } else if (message.type === 'assistant') {
          channel.markStreamingStarted();
          const parent = message.parent_tool_use_id ?? undefined;
          const sub = parent ? { parentToolUseId: parent } : {};
          if (!parent) {
            const amsg = (
              message as {
                message?: {
                  model?: string;
                  usage?: {
                    input_tokens?: number;
                    cache_read_input_tokens?: number;
                    cache_creation_input_tokens?: number;
                  };
                };
              }
            ).message;
            const cu = amsg?.usage;
            if (cu) {
              contextTokens =
                (cu.input_tokens ?? 0) +
                (cu.cache_read_input_tokens ?? 0) +
                (cu.cache_creation_input_tokens ?? 0);
              if (amsg?.model) contextModel = amsg.model;
              onEvent?.({
                kind: 'usage',
                contextTokens,
                ...(contextModel ? { contextModel } : {}),
                contextLimit: resolveContextLimit(contextModel),
              });
              if (!breakdownRequest) void startBreakdownRequest(true);
              if (
                rotationNudge &&
                legRotationRule.enabled &&
                contextTokens >= rotationNudge.softTokens
              ) {
                const level = Math.floor(
                  (contextTokens - rotationNudge.softTokens) / rotationNudge.reminderDeltaTokens,
                );
                if (level > firedNudgeLevel) {
                  const isFirst = firedNudgeLevel < 0;
                  firedNudgeLevel = level;
                  channel.injectRotationNudge(
                    isFirst ? rotationNudge.softText : rotationNudge.reminderText,
                  );
                }
              }
            }
          } else {
            const samsg = (
              message as {
                message?: {
                  model?: string;
                  usage?: {
                    input_tokens?: number;
                    cache_read_input_tokens?: number;
                    cache_creation_input_tokens?: number;
                  };
                };
              }
            ).message;
            const scu = samsg?.usage;
            if (scu) {
              const subTokens =
                (scu.input_tokens ?? 0) +
                (scu.cache_read_input_tokens ?? 0) +
                (scu.cache_creation_input_tokens ?? 0);
              const subModel = samsg?.model;
              onEvent?.({
                kind: 'usage',
                parentToolUseId: parent,
                contextTokens: subTokens,
                ...(subModel ? { contextModel: subModel } : {}),
                contextLimit: resolveContextLimit(subModel),
              });
            }
          }
          for (const block of message.message.content as Array<{
            type: string;
            id?: string;
            text?: string;
            name?: string;
            input?: unknown;
            thinking?: string;
          }>) {
            if (block.type === 'text' && block.text) {
              const isLimitLine = detectSessionLimitText(block.text);
              if (isLimitLine) {
                if (!sessionLimit) sessionLimit = textSessionLimitHit(block.text);
              } else {
                onEvent?.({ kind: 'text', text: block.text, ...sub });
              }
            } else if (block.type === 'thinking' && block.thinking) {
              if (richStream) onEvent?.({ kind: 'thinking', text: block.thinking, ...sub });
            } else if (block.type === 'tool_use' && block.name) {
              if (richStream)
                onEvent?.({
                  kind: 'tool_use',
                  id: block.id ?? '',
                  name: block.name,
                  input: block.input,
                  ...sub,
                });
              else onEvent?.({ kind: 'tool', name: block.name });
            }
          }
        } else if (richStream && message.type === 'user') {
          const userMsg = message as {
            parent_tool_use_id?: string | null;
            message?: { content?: unknown };
            tool_use_result?: unknown;
          };
          const parent = userMsg.parent_tool_use_id ?? undefined;
          const sub = parent ? { parentToolUseId: parent } : {};
          const patch = extractStructuredPatch(userMsg.tool_use_result);
          const content = userMsg.message?.content;
          if (Array.isArray(content)) {
            for (const block of content as Array<{
              type: string;
              tool_use_id?: string;
              content?: unknown;
              is_error?: boolean;
              text?: string;
            }>) {
              if (block.type === 'tool_result') {
                const isStreamClosed =
                  block.is_error === true && containsStreamClosed(block.content);
                streamClosedRun = isStreamClosed ? streamClosedRun + 1 : 0; // any healthy result resets the run
                if (isStreamClosed) streamClosedTotal++;
                onEvent?.({
                  kind: 'tool_result',
                  id: block.tool_use_id ?? '',
                  result: block.content,
                  isError: block.is_error,
                  ...(patch ? { structuredPatch: patch } : {}),
                  ...sub,
                });
                if (streamClosedRun >= STREAM_CLOSED_THRESHOLD) {
                  streamClosedTripped = true;
                  abortController.abort(); // stop the orphaned CLI child
                  throw new Error(
                    'engine stream closed: control channel severed mid-turn (circuit-breaker)',
                  );
                }
              } else if (block.type === 'text' && parent) {
                const text = block.text;
                if (text && text.trim())
                  onEvent?.({
                    kind: 'user_text',
                    text,
                    parentToolUseId: parent,
                  });
              }
            }
          }
        } else if (message.type === 'result') {
          resolvedSession = message.session_id;
          const errResult = message as { is_error?: boolean; result?: string };
          if (
            errResult.is_error === true &&
            errResult.result &&
            detectSessionLimitText(errResult.result)
          ) {
            sessionLimit ??= textSessionLimitHit(errResult.result);
            break;
          }
          if (message.subtype === 'success') {
            result = message.result;
            if (typeof claudeQuery.getContextUsage === 'function') {
              const idle = await waitForBreakdownRequest(breakdownRequest);
              if (idle && !breakdownRequest) {
                await waitForBreakdownRequest(startBreakdownRequest(false));
              }
            }
            onEvent?.({
              kind: 'turn_debug',
              terminalReason: (message as { terminal_reason?: string }).terminal_reason,
              stopReason: (message as { stop_reason?: string | null }).stop_reason,
            });
            const u = extractClaudeUsage(message, model);
            usage = usage ? addClaudeUsage(usage, u) : u;
            if (usage && contextTokens !== undefined) {
              usage.contextTokens = contextTokens;
              if (contextModel) usage.contextModel = contextModel;
            }
            if (usage && lastBreakdown) usage.contextBreakdown = lastBreakdown;
            if (streaming) {
              if (holdTimer.capping) {
                if (holdTimer.hasLiveSubagentTasks) channel.cancelEnd();
                else channel.scheduleEnd();
              } else if (!isTurnGenuinelyDone(message)) {
                if (sessionLimit) channel.scheduleEnd();
                else channel.cancelEnd();
              } else if (!holdTimer.hasLiveBgTasks) {
                channel.scheduleEnd(); // genuinely done, nothing in flight — close after the steer grace
              } else if (holdTimer.hasLiveSubagentTasks) {
                channel.cancelEnd(); // a live SUBAGENT — hold input open with NO timer (may run for hours; bounded only by PHASE_TIMEOUT / Stop)
              } else {
                holdTimer.armHoldTimer(); // only bare bg Bash left → the advisory cap
              }
            }
          } else {
            const r = message as unknown as {
              subtype: string;
              errors?: string[];
              stop_reason?: string | null;
              terminal_reason?: unknown;
              num_turns?: number;
            };
            const parts = [
              `Claude engine ended: ${r.subtype}`,
              r.stop_reason ? `stop_reason=${r.stop_reason}` : '',
              r.terminal_reason ? `terminal_reason=${JSON.stringify(r.terminal_reason)}` : '',
              r.errors?.length ? `errors=${r.errors.join(' | ')}` : '',
              stderrTail.length ? `stderr(tail)=${stderrTail.join('').slice(-2000)}` : '',
            ].filter(Boolean);
            const errorMessage = parts.join('; ');
            if (sessionLimit || detectSessionLimitText(errorMessage)) {
              sessionLimit ??= textSessionLimitHit(errorMessage);
              break;
            }
            throw new Error(errorMessage);
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isAuthErrorMessage(msg)) throw new EngineAuthError(msg, resolvedSession, 'claude');
      if (streamClosedTripped) throw err; // circuit-breaker: never treat as a cooperative abort
      if (detectSessionLimitText(msg)) {
        sessionLimit ??= textSessionLimitHit(msg);
      } else if (!(streaming && abortController.signal.aborted)) {
        throw err;
      }
    } finally {
      allowLiveBreakdownEvents = false;
      channel.markTurnEnded();
      channel.cancelEnd();
      holdTimer.clearHold();
      channel.dispose();
    }

    const planText = (planMode && capturedPlan) || undefined;
    const summary = planText || result || '(no summary)';
    onEvent?.({ kind: 'result', text: summary });
    if (streamClosedTotal > 0)
      onEvent?.({ kind: 'turn_debug', streamClosedCount: streamClosedTotal });

    const refreshedAuthSecret = args.persistAuthRefresh
      ? getEngineAuthAdapter('claude').readBackRefresh({
          homeRoot: this.homeRoot(),
          key: sandboxKey,
          writtenSecret: auth.secret,
        })
      : undefined;

    return {
      result: summary,
      sessionId: resolvedSession,
      ...(planText ? { planText } : {}),
      ...(usage ? { usage } : {}),
      ...(sessionLimit ? { sessionLimit } : {}),
      ...(streamClosedTotal > 0 ? { streamClosedCount: streamClosedTotal } : {}),
      ...(refreshedAuthSecret ? { refreshedAuthSecret } : {}),
    };
  }


  private getCodex(
    sandboxKey: EngineHomeKey,
    auth: EngineAuth,
    bridge?: CodexMcpBridge,
    extraMcpServers?: CodexExtraMcpServers,
  ): Codex {
    const root = this.homeRoot();
    const codexHome = ensureCodexAuthHome(root, sandboxKey, auth.secret, bridge, extraMcpServers);
    const cacheKey = `sub:${engineHomeKeyString(sandboxKey)}`;
    let client = this.codexClients.get(cacheKey);
    if (!client) {
      const env = { ...process.env, CODEX_HOME: codexHome } as Record<string, string>;
      client = new this.codexSdk.Codex({ env });
      this.codexClients.set(cacheKey, client);
    }
    return client;
  }

  private codexThreadOptions(
    cwd: string,
    model: string | undefined,
    reasoningEffort?: CodexReasoningEffort,
  ): ThreadOptions {
    return {
      workingDirectory: cwd,
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
      skipGitRepoCheck: true,
      webSearchMode: 'live',
      ...(model ? { model } : {}),
      modelReasoningEffort: reasoningEffort ?? 'xhigh',
    };
  }

  private async runCodex(
    args: RunEngineArgs,
    bridgeTools?: string[],
    extraMcpServers?: CodexExtraMcpServers,
  ): Promise<EngineRunResult> {
    const { task, cwd, systemPrompt, sandboxKey, sessionId, onEvent, signal, richStream } = args;
    const auth = this.resolveAuth('codex', args.auth);
    const model = args.model;

    const turnId = process.env.TURN_ID;
    const bridge: CodexMcpBridge | undefined =
      bridgeTools && bridgeTools.length > 0 && turnId
        ? {
            serverPath: CONTAINER_MCP_BRIDGE_PATH,
            toolNames: bridgeTools,
            env: {
              TURN_ID: turnId,
              REDIS_URL: process.env.REDIS_URL ?? 'redis://redis:6379',
            },
          }
        : undefined;

    const client = this.getCodex(sandboxKey, auth, bridge, extraMcpServers);
    const opts = this.codexThreadOptions(cwd, model, toCodexEffort(args.modelReasoningEffort));
    const thread = sessionId ? client.resumeThread(sessionId, opts) : client.startThread(opts);

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
                onEvent?.(
                  richStream
                    ? { kind: 'thinking', text: item.text }
                    : { kind: 'text', text: item.text },
                );
                break;
              case 'command_execution':
                if (richStream) {
                  const isError =
                    item.status === 'failed' || (item.exit_code != null && item.exit_code !== 0);
                  onEvent?.({
                    kind: 'tool_use',
                    id: item.id,
                    name: 'bash',
                    input: { command: item.command },
                  });
                  onEvent?.({
                    kind: 'tool_result',
                    id: item.id,
                    result: item.aggregated_output,
                    isError,
                  });
                } else {
                  onEvent?.({
                    kind: 'tool',
                    name: 'bash',
                    detail: item.command,
                  });
                }
                break;
              case 'file_change':
                if (richStream) {
                  const multi = item.changes.length > 1;
                  for (const [idx, change] of item.changes.entries()) {
                    const id = multi ? `${item.id}:${idx}` : item.id;
                    onEvent?.({
                      kind: 'tool_use',
                      id,
                      name: 'edit',
                      input: { file_path: change.path, kind: change.kind },
                    });
                    onEvent?.({
                      kind: 'tool_result',
                      id,
                      result: item.status,
                      isError: item.status === 'failed',
                      structuredPatch: computeCodexStructuredPatch(cwd, change.path, change.kind),
                    });
                  }
                } else {
                  onEvent?.({
                    kind: 'tool',
                    name: 'edit',
                    detail: item.changes.map((c) => `${c.kind} ${c.path}`).join(', '),
                  });
                }
                break;
              case 'web_search':
                if (richStream) {
                  onEvent?.({
                    kind: 'tool_use',
                    id: item.id,
                    name: 'web_search',
                    input: { query: item.query },
                  });
                  onEvent?.({
                    kind: 'tool_result',
                    id: item.id,
                    result: 'completed',
                  });
                } else {
                  onEvent?.({
                    kind: 'tool',
                    name: 'web_search',
                    detail: item.query,
                  });
                }
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
      const msg = err instanceof Error ? err.message : String(err);
      if (isAuthErrorMessage(msg)) throw new EngineAuthError(msg, resolvedSession, 'codex');
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

    const refreshedAuthSecret = args.persistAuthRefresh
      ? getEngineAuthAdapter('codex').readBackRefresh({
          homeRoot: this.homeRoot(),
          key: sandboxKey,
          writtenSecret: auth.secret,
        })
      : undefined;

    return {
      result: summary,
      sessionId: resolvedSession ?? thread.id ?? undefined,
      ...(usage ? { usage } : {}),
      ...(refreshedAuthSecret ? { refreshedAuthSecret } : {}),
    };
  }
}

export { addClaudeUsage, extractClaudeUsage } from './engine-core/usage';
