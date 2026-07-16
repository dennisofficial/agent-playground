import type { Codex, FileChangeItem, ThreadOptions } from '@openai/codex-sdk';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve as resolvePath } from 'node:path';
import { structuredPatch as diffStructuredPatch } from 'diff';
import {
  detectSessionLimitText,
  limitFromRateEvent,
  textSessionLimitHit,
  type SessionLimitHit,
} from './session-limit';
import {
  atlasEngineHomeDir,
  engineHomeKeyString,
  type EngineHomeKey,
} from './engine-home';
import {
  type CodexExtraMcpServers,
  type CodexMcpBridge,
  ensureCodexAuthHome,
} from './codex-auth-home';
import { getEngineAuthAdapter } from './engine-auth-adapter';

/** In-container path of the bundled Codex MCP tool-bridge server (baked by the Dockerfile, bind-mounted
 *  live — see `sandbox/image/mcp-bridge-server.ts`). codex spawns it via the config.toml `command`. */
const CONTAINER_MCP_BRIDGE_PATH = '/usr/local/lib/atlas/mcp-bridge-server.mjs';
import {
  bgTaskCapRule,
  BG_TASK_HOLD_CAP_MS,
  legRotationRule,
  ROTATION_REMINDER_DELTA_TOKENS,
  ROTATION_SOFT_TOKENS,
  svcNudgeRule,
  svcNudgeShouldFire,
  detectLongRunningCommand,
  SVC_NUDGE_TEXT,
  detectGithubHtmlUrl,
  renderGithubFetchNudge,
} from '../prompt-kit/jit';
import {
  EngineAuthError,
  isAuthErrorMessage,
  UNRESUMABLE_SESSION_MARKER,
  type CodexReasoningEffort,
  type EngineAuth,
  type EngineRunResult,
  type EngineUsage,
  type RunEngineArgs,
  type StructuredPatchHunk,
  resolveContextLimit,
} from './engine.types';
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
import { ClaudeAdapter } from './claude-adapter';
import { BackendCodexHomeProvisioner } from './codex-home-provisioner';
import { EngineAuthResolver } from './engine-core/auth-resolver';
import { BackgroundHoldTimer } from './engine-core/background-hold-timer';
import { buildClaudeOptions } from './engine-core/claude-options-builder';
import { normalizeContextBreakdown } from './engine-core/context-breakdown';
import { composeSkillsDir } from './engine-core/skills-composer';
import { SteerInputChannel } from './engine-core/steer-input-channel';
import {
  addClaudeUsage,
  extractClaudeUsage,
  toCodexEffort,
} from './engine-core/usage';

const requireFromHere = createRequire(__filename);

/**
 * Pull a well-formed `structuredPatch` (real file offsets) off an Edit/MultiEdit `tool_use_result`.
 * Returns undefined for any other tool, or when the shape doesn't match — so the caller simply omits it.
 */
function extractStructuredPatch(
  toolUseResult: unknown,
): StructuredPatchHunk[] | undefined {
  if (!toolUseResult || typeof toolUseResult !== 'object') return undefined;
  const raw = (toolUseResult as { structuredPatch?: unknown }).structuredPatch;
  if (!Array.isArray(raw)) return undefined;
  const hunks: StructuredPatchHunk[] = [];
  for (const h of raw) {
    if (!h || typeof h !== 'object') continue;
    const r = h as Record<string, unknown>;
    if (!Array.isArray(r.lines)) continue;
    const num = (v: unknown, fallback: number): number =>
      typeof v === 'number' ? v : fallback;
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
  if (typeof content === 'string')
    return content.toLowerCase().includes('stream closed');
  if (Array.isArray(content))
    return content.some((item) => containsStreamClosed(item));
  if (!content || typeof content !== 'object') return false;
  const block = content as { text?: unknown; content?: unknown };
  return (
    containsStreamClosed(block.text) || containsStreamClosed(block.content)
  );
}

/**
 * Codex's `file_change` item reports only `{ path, kind }` — never the before/after content the SDK
 * would need to hand us a diff (unlike Claude's Edit tool, which carries `old_string`/`new_string` and a
 * `structuredPatch` on its own tool result). Reconstruct one here: the last committed blob (`git show
 * HEAD:path`) stands in for "before" and the current on-disk file for "after". This is a `HEAD`-relative
 * diff, not a per-edit one — fine as long as the worktree isn't committed mid-turn (it isn't).
 */
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
  const patch = diffStructuredPatch(
    path,
    path,
    oldContent,
    newContent,
    undefined,
    undefined,
    { context: 3 },
  );
  return patch.hunks.length ? patch.hunks : undefined;
}

/**
 * `detectLongRunningCommand`/`renderSvcNudge`/`svcNudgeShouldFire`/`SVC_NUDGE_TEXT` moved to the `svc-nudge`
 * JIT rule (`prompt-kit/jit`, imported above) — the catalog owns the content now. Re-exported here so this
 * module's own callers/specs keep working unchanged.
 */
export { detectLongRunningCommand, svcNudgeShouldFire, SVC_NUDGE_TEXT };
// `detectGithubHtmlUrl`/`renderGithubFetchNudge` back the `github-fetch-guard` JIT rule (its PostToolUse hook is
// wired below). Re-exported here so this module's own spec exercises the same helpers, mirroring svc-nudge.
export { detectGithubHtmlUrl, renderGithubFetchNudge };

/**
 * A streaming success `result` is TERMINAL — the model genuinely ended its turn — only when it carries
 * `terminal_reason:'completed'` (or, defensively for CLI drift, no `terminal_reason` and a natural
 * `stop_reason:'end_turn'`). The CLI also emits success results MID-turn when it PAUSES the loop for a
 * rate-limit / retry / budget interrupt (`terminal_reason` `'blocking_limit'`/`'rapid_refill_breaker'`/
 * `'background_requested'`/`'tool_deferred'`, or absent without an end_turn) — it will resume and may
 * still invoke host tools, so input must stay OPEN. Closing stdin under a still-active turn makes every
 * subsequent host-tool call throw a bare "Stream closed" (prod incident b30616d2). Verified against
 * sdk 0.3.201: a genuinely-completed turn — even one that calls a host tool mid-turn — emits exactly one
 * result with terminal_reason 'completed' + stop_reason 'end_turn', so gating here still ends normal turns.
 */
function isTurnGenuinelyDone(m: {
  terminal_reason?: string;
  stop_reason?: string | null;
}): boolean {
  if (m.terminal_reason === 'completed') return true;
  if (m.terminal_reason == null && m.stop_reason === 'end_turn') return true;
  return false;
}

export { toClaudeEffort, toCodexEffort } from './engine-core/usage';

/**
 * The Atlas v2 ENGINE CORE — the vendor logic for running ONE Claude/Codex turn, with **zero Nest and
 * zero @core dependencies**. It is the single implementation shared by two callers:
 *   - the in-process Nest `EngineRunner` (host-local execution), and
 *   - the in-container engine entrypoint (`image/engine-entrypoint.ts`), bundled into the sandbox
 *     image and invoked via `docker exec` — so a turn behaves IDENTICALLY on the host and in a sandbox.
 *
 * It does exactly four things: plan/review (read-only) vs execute (writes confined to the worktree);
 * thread the run's subscription secret (always subscription — no api_key path); pin an ISOLATED agent home (CLAUDE_CONFIG_DIR/CODEX_HOME,
 * never the personal one); return { result, sessionId?, planText?, usage? }. Env-derived knobs arrive as
 * an {@link EngineCoreConfig} (read from `EnvService` on the host, from `process.env` in the container).
 */

/** Env-derived configuration (the values the host reads from EnvService, the container from process.env). */
export interface EngineCoreConfig {
  /** Root for the isolated agent home (from AGENT_HOME_ROOT). */
  homeRoot?: string;
  /**
   * Root of the org-scoped skills store this run resolves a non-`managed` `RunEngineArgs.skills[].dirPath`
   * against (from `SKILLS_ROOT` — in-sandbox, always `CONTAINER_SKILLS_STORE`, set by
   * `redis-engine-runner.ts`'s exec env). Undefined (e.g. a bare unit test with no cfg) → the
   * skills-compose step skips every non-managed skill (still symlinks any `managed` one).
   */
  skillsRoot?: string;
  /**
   * Root of Atlas's own MANAGED (system-tier) STATIC skills a `managed: true` `RunEngineArgs.skills[].dirPath`
   * resolves against (from `SKILLS_MANAGED_ROOT` — in-sandbox, always `CONTAINER_SKILLS_MANAGED`, set by
   * `redis-engine-runner.ts`'s exec env). Undefined → the skills-compose step skips every managed skill.
   */
  managedSkillsRoot?: string;
  /**
   * Root of Atlas's own MANAGED (system-tier) GIT-SOURCED skills a `managedGit: true`
   * `RunEngineArgs.skills[].dirPath` resolves against (from `SKILLS_MANAGED_GIT_ROOT` — in-sandbox, always
   * `CONTAINER_SKILLS_MANAGED_GIT`, set by `redis-engine-runner.ts`'s exec env). Undefined → the
   * skills-compose step skips every git-managed skill.
   */
  managedGitSkillsRoot?: string;
}

/**
 * The agentic-engine model ids — CODE CONSTANTS, never env-configured (env vars are for per-environment
 * config; the model choice doesn't change across local/dev/staging/prod). A per-turn `args.model` still
 * overrides (e.g. the thread brain pins its own Opus). The Claude id is the current Sonnet 5 model id —
 * the builder lane orchestrator (and its `post_review` autofix child) run on this; the Codex id is the
 * Codex SDK's coding model.
 */
const DEFAULT_WORKER_MODEL = 'claude-sonnet-5';
// NOTE: Codex runs subscription-only here — a ChatGPT-account OAuth token (see `resolveAuth`; there is no
// API-key path). A ChatGPT account REJECTS any explicit model with a 400 ("The '<model>' model is not
// supported when using Codex with a ChatGPT account"), including `gpt-5-codex` and `gpt-5`. So we do NOT
// pin a Codex model — we leave it unset and let the Codex SDK use the account's own default model.

/**
 * Whether a resumable Claude session transcript exists under this config dir. The SDK stores it at
 * `<configDir>/projects/<cwd-slug>/<sessionId>.jsonl`; we scan the project dirs rather than recompute
 * the slug. Passing `resume` for a session whose transcript ISN'T here makes the SDK end the turn with a
 * generic `error_during_execution` — so we check first and raise a specific error instead.
 */
export function claudeSessionExists(
  configDir: string,
  sessionId: string,
): boolean {
  const projects = join(configDir, 'projects');
  let dirs: string[];
  try {
    dirs = readdirSync(projects);
  } catch {
    return false; // no projects dir yet → nothing to resume
  }
  return dirs.some((d) => existsSync(join(projects, d, `${sessionId}.jsonl`)));
}

// Static subagent/tool-allowlist config (WEB_TOOLS, SUBAGENT_MGMT_TOOLS, WORKER_TOOLS, PLAN_TOOLS,
// REVIEW_TOOLS, AUTO_APPROVE, the LSP tool sets, SUBAGENTS/WRITER_SUBAGENTS/VALIDATE_SUBAGENT/
// PROTOTYPE_SUBAGENT, and applyPerRunCtxToAgents) now lives in `./engine-core/agents-registry`. Re-exported
// here so this module's own callers/specs keep working unchanged.
export { applyPerRunCtxToAgents } from './engine-core/agents-registry';

export { composeSkillsDir } from './engine-core/skills-composer';

export type { SkillGuardCtx } from './engine-core/tool-permission';
export { makeCanUseTool } from './engine-core/tool-permission';

export class EngineCore {
  // One Codex client per (auth, sandbox) — each funds its own runs from its own home.
  private readonly codexClients = new Map<string, Codex>();
  private readonly authResolver = new EngineAuthResolver();

  // The SDK modules are injected (host + container share this class); env-derived knobs arrive as `cfg`.
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

  /** Resolve the run's subscription secret — see {@link EngineAuthResolver}. */
  private resolveAuth(
    engine: 'claude' | 'codex',
    explicit: EngineAuth | undefined,
  ): EngineAuth {
    return this.authResolver.resolve(engine, explicit);
  }

  async run(args: RunEngineArgs): Promise<EngineRunResult> {
    const appserver = args.engine === 'codex' && this.codexAppServerEnabled();
    return this.stampUsageProvenance(
      await (args.engine === 'codex'
        ? appserver
          ? this.runCodexAppServer(args)
          : this.runCodex(args)
        : new ClaudeAdapter(this.runClaude.bind(this), args).run(
            this.toAdapterArgs(args),
          )),
      args,
      appserver,
    );
  }

  /**
   * Map the host-only {@link RunEngineArgs} down to the slim, vendor-agnostic {@link AdapterRunArgs} the
   * {@link EngineAdapter} port consumes. Only the cross-engine fields cross this seam — the Claude-specific
   * extras (`steerInput`/`rotationNudge`/`skills`/`grantedSkills`/`repoConventions`/…) are retained by
   * `ClaudeAdapter` from the full args, so nothing `runClaude` needs is lost.
   *
   * `authOverride`, when passed, wins over `args.auth` — used by {@link runCodexAppServer}, which (unlike
   * the Claude branch) MUST hand the port a resolved secret: `CodexAppServerAdapter.run` throws on a
   * missing `auth`, whereas `args.auth` alone may be undefined (resolved lazily inside legacy `runCodex`).
   */
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
      ...(authOverride
        ? { auth: authOverride }
        : args.auth
          ? { auth: args.auth }
          : {}),
      ...(args.model ? { model: args.model } : {}),
      ...(args.modelReasoningEffort
        ? { modelReasoningEffort: args.modelReasoningEffort }
        : {}),
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

  /**
   * Assemble a Codex-app-server turn's {@link EngineLocalHooks} from the SAME JIT rule catalog Claude's
   * `ClaudeAdapter.buildHooks` reads (svc-nudge, leg-rotation) plus the structural write-guard (always built,
   * unconditional on any rule's `enabled` flag — it's the read-only/root-confinement security boundary, not a
   * nudge). {@link guardHooksAgainstCapabilities} then drops any field the adapter's declared capability set
   * can't honor, so a future capability change here degrades honestly instead of silently no-op-ing mid-turn.
   */
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

  /**
   * Whether a Codex turn should route through the `codex app-server` JSON-RPC {@link CodexAppServerAdapter}
   * (thread 1's `@workspace/codex-sdk`) instead of the legacy `@openai/codex-sdk` exec-JSONL `runCodex`.
   * Read straight off `process.env` (like other run-time knobs in this file, e.g.
   * `ENGINE_STREAM_CLOSED_THRESHOLD` in `runClaude`) rather than {@link EngineCoreConfig} — this is a
   * default-OFF cutover flag, not host-resolved per-env config. Default OFF: `runCodex` stays the default
   * Codex path until the two review roles cut over (see the locked decision record).
   */
  private codexAppServerEnabled(): boolean {
    return (
      process.env.CODEX_APPSERVER_ENABLED === 'true' ||
      process.env.CODEX_APPSERVER_ENABLED === '1'
    );
  }

  /**
   * The custom SDK defaults to spawning `codex` from PATH because it is standalone. Backend deployments
   * already carry `@openai/codex` for the CLI binary. Resolve that direct dependency here,
   * at the Atlas-owned adapter boundary, instead of adding monorepo coupling to `@workspace/codex-sdk`.
   */
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

  /**
   * Route a Codex turn through the port: resolve auth up front (the adapter throws on a missing secret,
   * so resolve here rather than let it throw a less specific error), then hand off to
   * {@link CodexAppServerAdapter}. A fresh {@link BackendCodexHomeProvisioner} per call mirrors how
   * `ClaudeAdapter` is constructed fresh per turn — no cross-turn state.
   */
  private async runCodexAppServer(
    args: RunEngineArgs,
  ): Promise<EngineRunResult> {
    const auth = this.resolveAuth('codex', args.auth);
    const adapter = new CodexAppServerAdapter(
      new BackendCodexHomeProvisioner(this.homeRoot()),
      this.codexAppServerSpawnOptions(),
    );
    return adapter.run(
      this.toAdapterArgs(
        args,
        auth,
        this.buildCodexHooks(args, adapter.capabilities),
      ),
    );
  }

  /**
   * Stamp display-only provenance the engine paths don't carry themselves onto the returned usage: the
   * `engine` that ran (so a Codex turn with no `model` still labels as "Codex"), the `reasoningEffort`
   * the run was given (engine-agnostic — Codex AND Claude, never surfaced by either SDK's result), and
   * — Codex only — whether this turn ran through the app-server port (`appserver`). Applied at BOTH
   * dispatch wrappers (`run` / `runWithExtras`) so every engine turn — build, Codex review, autofix —
   * is covered without touching `runClaude`/`runCodex` internals or any transcript `metaTag` call site.
   * `??=` so a path that ever populates these itself wins. No-op when the run produced no usage.
   */
  private stampUsageProvenance(
    res: EngineRunResult,
    args: RunEngineArgs,
    appserver?: boolean,
  ): EngineRunResult {
    if (res.usage) {
      res.usage.engine ??= args.engine;
      if (args.modelReasoningEffort)
        res.usage.reasoningEffort ??= args.modelReasoningEffort;
      if (args.engine === 'codex') res.usage.appserver ??= !!appserver;
    }
    return res;
  }

  /**
   * Like `run`, but passes extra Claude SDK options (e.g. `mcpServers` for the tool bridge) plus the
   * bridge's MCP tool names. Used by the in-container entrypoint when the tool-bridge is active; the
   * host `EngineRunner` calls the plain `run` path (the bridge is wired host-side there).
   *
   * `extraClaudeOptions` is spread verbatim into the SDK `Options` — pass `{ mcpServers }`, NOT the
   * raw server map, or the server lands as a stray top-level key and never registers.
   * `bridgeToolNames` are the qualified `mcp__<server>__<tool>` names to auto-approve (Claude only).
   * `codexBridgeTools` are the BARE host tool names for a Codex execute turn — routed into `runCodex`,
   * which renders them as an `[mcp_servers.atlasbridge]` config.toml block (the Codex tool bridge).
   *
   * `CodexAppServerAdapter` carries no bridge/tool-bridge wiring in thread 2 (`writeGuard`/`richStream`
   * capabilities only), so a call with non-empty `codexBridgeTools`/`codexExtraMcpServers` ALWAYS falls
   * back to legacy `runCodex` regardless of `CODEX_APPSERVER_ENABLED` — a caller that explicitly needs
   * the bridge gets the path that actually supports it, rather than silently dropping its tools.
   */
  async runWithExtras(
    args: RunEngineArgs,
    extraClaudeOptions?: Record<string, unknown>,
    bridgeToolNames?: string[],
    codexBridgeTools?: string[],
    codexExtraMcpServers?: CodexExtraMcpServers,
  ): Promise<EngineRunResult> {
    const hasCodexBridgeExtras =
      (codexBridgeTools?.length ?? 0) > 0 ||
      Object.keys(codexExtraMcpServers ?? {}).length > 0;
    const appserver =
      args.engine === 'codex' &&
      this.codexAppServerEnabled() &&
      !hasCodexBridgeExtras;
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

  // ── Claude ────────────────────────────────────────────────────────────────────────────────────

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

    // The steerable-brain input channel: the live manual-input handle, its steer-idle close timer, the
    // pre-stream steer buffer, and the detached operator-steer consumer. Non-steerable worker turns keep the
    // plain string prompt — `channel.streaming` is false and the loop's steer branches are all no-ops.
    const channel = new SteerInputChannel(steerInput, task, hooks, onEvent);
    const streaming = channel.streaming;

    // Stream-closed circuit breaker: consecutive "Stream closed" tool_results in the live run trip it.
    const STREAM_CLOSED_THRESHOLD =
      Number(process.env.ENGINE_STREAM_CLOSED_THRESHOLD) > 0
        ? Number(process.env.ENGINE_STREAM_CLOSED_THRESHOLD)
        : 3; // consecutive control-channel failures ⇒ breaker trips
    let streamClosedRun = 0; // consecutive "Stream closed" tool_results in the live run (any healthy result resets)
    let streamClosedTotal = 0; // per-turn total (instrumentation)
    let streamClosedTripped = false; // latched right before the breaker throw so the catch never swallows it as a cooperative abort
    // ENGINE-LOCAL Leg-rotation nudge (see RunEngineArgs.rotationNudge): the highest delta-band injected into
    // this turn's live input so far (-1 before soft; 0 = soft) — the level-latch for the nudge fired below.
    let firedNudgeLevel = -1;

    // HOLD_CAP_MS is read LIVE from the JIT catalog each run (so a spec can mutate the rule); the
    // BackgroundHoldTimer owns the rest of the background-task hold contract (see its doc).
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

    // Pin the SDK subprocess to Atlas's ISOLATED config/state home — never ~/.claude.
    const claudeConfigDir = atlasEngineHomeDir(
      this.homeRoot(),
      'claude',
      sandboxKey,
    );

    // A stored sessionId whose transcript isn't in THIS config dir can't be resumed — the SDK would end
    // the turn with an opaque `error_during_execution`. Detect it up front and fail with a SPECIFIC,
    // actionable error (retrying is futile; the thread must be recreated). See UNRESUMABLE_SESSION_MARKER.
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
      // Let the SDK ride out retryable API errors (overloaded/5xx/gateway/rate-limit) natively with its own
      // exponential backoff instead of failing the turn on the first occurrence; its `api_retry` frames are
      // surfaced below to drive the live "Reconnecting…" indicator. Env-overridable for tuning/tests.
      CLAUDE_CODE_MAX_RETRIES: process.env.CLAUDE_CODE_MAX_RETRIES ?? '10',
    };
    getEngineAuthAdapter('claude').materialize({
      homeRoot: this.homeRoot(),
      key: sandboxKey,
      secret: auth.secret,
      kind: auth.kind,
      env: subprocessEnv,
    });

    // Capture the CLI subprocess's stderr (the real API/transport error text) into a bounded ring
    // buffer so a non-success result can surface it — the SDK otherwise flattens it into `subtype`.
    const stderrTail: string[] = [];
    const captureStderr = (data: string) => {
      stderrTail.push(data);
      if (stderrTail.length > 40) stderrTail.shift(); // keep the last ~40 chunks
    };

    // This repo's skills (resolved host-side, dir paths + names only — no bodies) composed into
    // `<claudeConfigDir>/skills/` as write-through symlinks into the central skills store, for the SDK to
    // discover NATIVELY (settingSources 'user'/'project' + skills 'all' below). Re-composed every turn (wipes a
    // removed/disabled skill); a no-op wipe when the turn carries none.
    composeSkillsDir(
      claudeConfigDir,
      args.skills,
      this.skillsRoot(),
      this.managedSkillsRoot(),
      this.managedGitSkillsRoot(),
    );

    // Live context-window occupancy (distinct from the cumulative billing total): each `assistant`
    // message is ONE model round-trip whose own `usage` reports the input size of THAT call (fresh +
    // cache read + cache creation) — the real context size at that moment. We keep the MAIN agent's
    // LAST round-trip (turn-end occupancy) + its model. Subagent messages (parent_tool_use_id set) run
    // in their OWN context on cheaper models, so they're excluded. Declared BEFORE the options build so the
    // `postToolUseContext` hook it assembles can read the LIVE value by reference mid-query.
    let contextTokens: number | undefined;
    let contextModel: string | undefined;
    // The last normalized full breakdown (live mid-turn snapshot, superseded by the awaited end-of-turn
    // fetch below) — rides onto `usage.contextBreakdown` at turn end (step f). `breakdownInFlight` guards
    // the live fetch (step d) so a slow control round-trip never piles up mid-stream.
    let lastBreakdown: ContextBreakdown | undefined;
    let breakdownInFlight = false;

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
        onEvent?.({ kind: 'jit_injection', id: inj.toolUseId, rule: inj.rule, text: inj.text }),
    });

    let result = '';
    let resolvedSession = sessionId;
    let usage: EngineUsage | undefined;
    // Set the instant we detect a Claude subscription session/usage-limit wall (structured
    // `rate_limit_event` status:'rejected', or the printed-line fallback). Its presence flips the turn from
    // "hold input open + resume" to "end CLEANLY" so we never auto-resume straight back into the wall.
    let sessionLimit: SessionLimitHit | undefined;
    try {
      const claudeQuery = this.claudeSdk.query({
        prompt: channel.prompt,
        options,
      });
      for await (const message of claudeQuery) {
        // Model is actively producing (or a steer is being processed) → don't close input under it. Once
        // `capping` latches, a late task_progress/task_updated frame must NOT undo the forced close.
        if (streaming && !holdTimer.capping && message.type !== 'result')
          channel.cancelEnd();
        if (message.type === 'system' && message.subtype === 'init') {
          resolvedSession = message.session_id;
          // Surface the resume handle the instant the session exists, so a mid-turn halt is recoverable.
          if (resolvedSession)
            onEvent?.({ kind: 'session', sessionId: resolvedSession });
        } else if (
          message.type === 'system' &&
          message.subtype === 'task_started'
        ) {
          // An SDK run_in_background Bash task began — track it so the turn holds its input open until the
          // task settles (its `task_notification`) instead of closing on the immediate first `result`. A Task
          // SUBAGENT's task_started carries `subagent_type` (task_type "local_agent"); a bare bg Bash does not
          // (task_type "local_bash") — a live subagent runs uncapped, so track it separately.
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
            // The spawning Task tool_use id, present for a backgrounded Task subagent — lets the web tie this
            // to the subagent's card (its child blocks' `parentToolUseId`).
            ...(message.tool_use_id
              ? { parentToolUseId: message.tool_use_id }
              : {}),
          });
        } else if (
          message.type === 'system' &&
          message.subtype === 'task_notification'
        ) {
          // The task settled (completed/failed/stopped). Drop it from the live set; a settlement +
          // auto-continuation is imminent, so restart the hold window (or clear it if none remain).
          onEvent?.({
            kind: 'bg_task',
            taskId: message.task_id,
            status: message.status,
            detail: message.summary,
            // Settlement of a backgrounded Task subagent — carry the spawning Task id so the web marks that
            // subagent's card settled (its anchor `tool_result` was only the immediate launch ack).
            ...(message.tool_use_id
              ? { parentToolUseId: message.tool_use_id }
              : {}),
          });
          holdTimer.trackTaskSettled(message.task_id);
        } else if (
          message.type === 'system' &&
          message.subtype === 'api_retry'
        ) {
          // The SDK hit a retryable API error (overloaded/5xx/gateway/rate-limit) and is retrying NATIVELY
          // with its own backoff — surface it (we do NOT host-retry these) so the live indicator can show the
          // SDK's own countdown. Mid-turn: no turn end, the turn continues once a retry succeeds.
          onEvent?.({
            kind: 'api_retry',
            attempt: message.attempt,
            maxRetries: message.max_retries,
            retryDelayMs: message.retry_delay_ms,
            errorStatus: message.error_status ?? null,
            reason: String(message.error),
          });
        } else if (message.type === 'rate_limit_event') {
          // Harvest the subscription window state ALWAYS (the host updates its per-org usage snapshot from
          // every frame, not just the wall). A `rejected` frame is the HARD limit — latch it so the result
          // frame below ends the turn cleanly instead of holding input open to resume into the wall.
          const info = message.rate_limit_info;
          onEvent?.({
            kind: 'rate_limit',
            status: info.status,
            ...(info.resetsAt != null ? { resetsAt: info.resetsAt } : {}),
            ...(info.rateLimitType
              ? { rateLimitType: info.rateLimitType }
              : {}),
            ...(info.utilization != null
              ? { utilization: info.utilization }
              : {}),
          });
          const hit = limitFromRateEvent(info);
          if (hit) sessionLimit = hit;
        } else if (richStream && message.type === 'stream_event') {
          // LIVE token-by-token deltas (partial-message stream). Authoritative full blocks still arrive
          // on the `assistant` message below — these are for live rendering only, not persistence. Carry
          // the subagent parent id (same as the authoritative blocks) so live nested rendering matches.
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
          // First committed assistant message ⇒ the turn is genuinely streaming: a held steer can now inject
          // with priority:'now' without aborting the turn. Flush the pre-stream hold buffer (no-op after the
          // first message / for turns that never held anything).
          channel.markStreamingStarted();
          // `parent_tool_use_id` is UNSET for the brain's own blocks, SET to the spawning Task id for a
          // subagent's blocks (forwardSubagentText forwards subagent text/thinking the same way).
          const parent = message.parent_tool_use_id ?? undefined;
          const sub = parent ? { parentToolUseId: parent } : {};
          // Context occupancy: only the MAIN agent's round-trips (parent unset). This message's OWN
          // usage is the single-call input size (NOT the cumulative turn total) — keep the latest as
          // the turn-end occupancy, with the call's model so the ring resolves the right window.
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
              // Emit the occupancy LIVE so the composer ring fills mid-turn (a turn can run for minutes). Fires
              // once per main-agent round-trip; the turn-end `turn_meta` remains the durable authority.
              onEvent?.({
                kind: 'usage',
                contextTokens,
                ...(contextModel ? { contextModel } : {}),
                contextLimit: resolveContextLimit(contextModel),
              });
              // LIVE full breakdown fetch — a SEPARATE control request from the scalar read above (which
              // reads the fields already carried on the SDK message that just arrived; this is a NEW async
              // control round-trip out to the CLI). Fire-and-forget + in-flight-guarded so it can never block
              // or pile up mid-stream: a slow response just means THIS round-trip's breakdown is skipped, not
              // queued behind the next one. Absent `getContextUsage` (an older CLI, or Codex-adjacent) is a
              // silent no-op — the scalar occupancy above still works.
              if (
                !breakdownInFlight &&
                typeof claudeQuery.getContextUsage === 'function'
              ) {
                breakdownInFlight = true;
                void claudeQuery
                  .getContextUsage()
                  .then((raw) => {
                    lastBreakdown = normalizeContextBreakdown(raw);
                    onEvent?.({
                      kind: 'context_breakdown',
                      breakdown: lastBreakdown,
                    });
                  })
                  .catch(() => {
                    // Unsupported / transient control-channel error → keep scalar-only, no throw into the turn.
                  })
                  .finally(() => {
                    breakdownInFlight = false;
                  });
              }
              // ENGINE-LOCAL Leg-rotation nudge: this main-agent round-trip's occupancy is the freshest signal,
              // and we're mid-stream (input open, streamingStarted true) — the SAFE moment to steer, so the nudge
              // lands like a manual steer instead of racing the post-`result` close. Level-latch (parity with the
              // driver's LegRotationWatch): the FIRST crossing injects the SOFT nudge; each further +delta band
              // injects the REMINDER. Fires the highest band crossed, each band at most once. No hard stop.
              // Enablement + thresholds + payload text come per-turn from `rotationNudge` (RunEngineArgs, seeded
              // by the driver from `ROTATION_SOFT_NUDGE`/`ROTATION_REMINDER_NUDGE`). The `leg-rotation` JIT rule
              // is the catalog SOURCE of those thresholds (see `resolveRotationThresholds`) and mirrors the same
              // payload text — kept as the injectable per-turn field so a caller can distinguish the phases.
              if (
                rotationNudge &&
                legRotationRule.enabled &&
                contextTokens >= rotationNudge.softTokens
              ) {
                const level = Math.floor(
                  (contextTokens - rotationNudge.softTokens) /
                    rotationNudge.reminderDeltaTokens,
                );
                if (level > firedNudgeLevel) {
                  const isFirst = firedNudgeLevel < 0;
                  firedNudgeLevel = level;
                  channel.injectRotationNudge(
                    isFirst
                      ? rotationNudge.softText
                      : rotationNudge.reminderText,
                  );
                }
              }
            }
          } else {
            // SUBAGENT round-trip (parent set): emit ITS OWN occupancy tagged with the spawning Task id, so
            // the subagent card renders its own context ring + real model. Kept strictly separate from the
            // main-agent `contextTokens`/`contextModel` above — a subagent must NEVER overwrite the
            // orchestrator's ring or the turn's `usage.contextModel`. Live-only, like the main-agent emit.
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
              // Suppress the printed limit line at the source (kills the bare/doubled limit line). If the
              // structured frame hasn't already latched the hit, latch it here from the text.
              const isLimitLine = detectSessionLimitText(block.text);
              if (isLimitLine) {
                if (!sessionLimit)
                  sessionLimit = textSessionLimitHit(block.text);
              } else {
                onEvent?.({ kind: 'text', text: block.text, ...sub });
              }
            } else if (block.type === 'thinking' && block.thinking) {
              if (richStream)
                onEvent?.({ kind: 'thinking', text: block.thinking, ...sub });
            } else if (block.type === 'tool_use' && block.name) {
              // Rich turns get the full tool call (id + input) so the UI can render it; coarse turns keep
              // the legacy name-only `tool` event.
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
          // Tool results are fed back to the model as a `user` message — surface them so the UI can pair
          // each result with its `tool_use` by id. A subagent's tool results carry the same parent id.
          const userMsg = message as {
            parent_tool_use_id?: string | null;
            message?: { content?: unknown };
            tool_use_result?: unknown;
          };
          const parent = userMsg.parent_tool_use_id ?? undefined;
          const sub = parent ? { parentToolUseId: parent } : {};
          // Edit/MultiEdit results carry a `structuredPatch` (real file line offsets) on the message's
          // `tool_use_result` — forward it so the web diff gutter shows true line numbers, not 1-based.
          const patch = extractStructuredPatch(userMsg.tool_use_result);
          const content = userMsg.message?.content;
          if (Array.isArray(content)) {
            for (const block of content as Array<{
              type: string;
              tool_use_id?: string;
              content?: unknown;
              is_error?: boolean;
            }>) {
              if (block.type === 'tool_result') {
                const isStreamClosed =
                  block.is_error === true &&
                  containsStreamClosed(block.content);
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
              }
            }
          }
        } else if (message.type === 'result') {
          resolvedSession = message.session_id;
          // The CLI sometimes reports a subscription wall as an `is_error` result whose subtype is still
          // `success` — its `result` string is the printed limit line — then exits non-zero (the SDK then
          // throws "Claude Code returned an error result: …"). That is NOT a genuine answer: latch the hit
          // and break to the clean-park return, so the caller parks + auto-resumes instead of surfacing the
          // limit line as the turn result (or letting the thrown exit-error fail the build). The structured
          // `rate_limit_event` path keeps its existing success handling below (its result carries no limit text).
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
            // AUTHORITATIVE end-of-turn breakdown fetch — unlike the live fetch above, this one is AWAITED:
            // a fire-and-forget live fetch might not have resolved yet when `finish()` reads
            // `usage.contextBreakdown` below, so the durable persisted value must come from a call we KNOW
            // has settled. Still mid-iteration (the query handle is alive) so the control channel is
            // reachable. On failure, keep whatever the live path above already captured, if anything.
            if (typeof claudeQuery.getContextUsage === 'function') {
              try {
                lastBreakdown = normalizeContextBreakdown(
                  await claudeQuery.getContextUsage(),
                );
              } catch {
                // keep whatever the live path above already captured, if anything
              }
            }
            onEvent?.({
              kind: 'turn_debug',
              terminalReason: (message as { terminal_reason?: string })
                .terminal_reason,
              stopReason: (message as { stop_reason?: string | null })
                .stop_reason,
            });
            // A background-task hold produces ≥2 results per turn (the immediate first result + the
            // auto-continuation after the task settles). SUM the billing tokens across results; the
            // contextTokens/contextModel/model/modelUsage below all reflect the LATEST result (turn-end
            // occupancy). The `result` string keeps the last result too — the final answer.
            const u = extractClaudeUsage(message, model);
            usage = usage ? addClaudeUsage(usage, u) : u;
            // Attach the per-call context occupancy (+ its model) onto the billing usage. The cumulative
            // `inputTokens` stays the billing number; `contextTokens` is the real window occupancy. Runs for
            // EVERY result so the FINAL result's occupancy wins.
            if (usage && contextTokens !== undefined) {
              usage.contextTokens = contextTokens;
              if (contextModel) usage.contextModel = contextModel;
            }
            // The durable value rides EngineRunResult.usage.contextBreakdown, same channel as contextTokens above.
            if (usage && lastBreakdown) usage.contextBreakdown = lastBreakdown;
            // Streaming-input mode: decide whether this success result ends the turn.
            if (streaming) {
              if (holdTimer.capping) {
                // The advisory cap fired — the model's next natural result ends the turn via the NORMAL
                // grace, unless a background subagent is now live and must remain uncapped.
                if (holdTimer.hasLiveSubagentTasks) channel.cancelEnd();
                else channel.scheduleEnd();
              } else if (!isTurnGenuinelyDone(message)) {
                // A paused/interrupted success result (rate-limit / retry / budget) is NOT the end of the
                // turn — keep input OPEN so the CLI can resume and may still call host tools (closing stdin
                // under an in-flight call orphans it → "Stream closed"). See #65. EXCEPT when we've hit a
                // subscription session limit: resuming would drive straight back into the wall, so end the
                // turn CLEANLY (the caller parks the lane + auto-resumes at resetAt) instead of holding open.
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
            // Surface the SDKResultError detail the SDK otherwise flattens into `subtype`.
            // Keep the leading `Claude engine ended: <subtype>` intact — isAuthErrorMessage
            // (below) and downstream matching key off it; only APPEND detail.
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
              r.terminal_reason
                ? `terminal_reason=${JSON.stringify(r.terminal_reason)}`
                : '',
              r.errors?.length ? `errors=${r.errors.join(' | ')}` : '',
              stderrTail.length
                ? `stderr(tail)=${stderrTail.join('').slice(-2000)}`
                : '',
            ].filter(Boolean);
            const errorMessage = parts.join('; ');
            // A non-success end that is really a subscription session-limit wall must NOT throw the generic
            // engine error — it is a clean park, not a failure. Latch it (from the text if the structured
            // frame didn't already) and break so the normal return path carries `sessionLimit` back.
            if (sessionLimit || detectSessionLimitText(errorMessage)) {
              sessionLimit ??= textSessionLimitHit(errorMessage);
              break;
            }
            throw new Error(errorMessage);
          }
        }
      }
    } catch (err) {
      // A 401 / expired token / "not logged in" → a RESUMABLE auth error carrying the live session,
      // so the driver pauses (not fails) and a re-ping continues this same session. Else re-throw.
      const msg = err instanceof Error ? err.message : String(err);
      if (isAuthErrorMessage(msg))
        throw new EngineAuthError(msg, resolvedSession, 'claude');
      if (streamClosedTripped) throw err; // circuit-breaker: never treat as a cooperative abort
      // Backstop: a subscription wall that surfaced ONLY as a thrown SDK error (e.g. "Claude Code returned
      // an error result: You've hit your session limit …") — no frame latched it first. That is a clean
      // park, not a crash: record the hit and fall through to the normal post-loop return so the caller
      // parks the lane + auto-resumes at resetAt, instead of failing the build with the generic engine error.
      if (detectSessionLimitText(msg)) {
        sessionLimit ??= textSessionLimitHit(msg);
      } else if (!(streaming && abortController.signal.aborted)) {
        // Cooperative STOP of a STEERABLE turn (operator Stop): the SDK iterator was cancelled. Treat as a
        // graceful end — fall through to the normal post-loop return with the partial result + live session,
        // so the turn finalizes cleanly (partial transcript persisted, session resumable) rather than
        // erroring. Non-streaming worker turns keep throwing on abort (the driver's timeout race depends on it).
        throw err;
      }
    } finally {
      // Stop feeding/consuming input so the detached steer consumer + entrypoint generator unwind.
      channel.markTurnEnded();
      channel.cancelEnd();
      holdTimer.clearHold();
      channel.dispose();
    }

    // On a plan turn the substance is the captured plan, not the closing summary.
    const planText = (planMode && capturedPlan) || undefined;
    const summary = planText || result || '(no summary)';
    onEvent?.({ kind: 'result', text: summary });
    if (streamClosedTotal > 0)
      onEvent?.({ kind: 'turn_debug', streamClosedCount: streamClosedTotal });

    // Auth-refresh write-back: a personal credential's `.credentials.json` is rewritten in place when the
    // SDK self-refreshes it. Read it back and relay it so the host can persist the fresh blob. Gated on
    // `persistAuthRefresh` — the host only sets it for ORG-sourced auth, so an env-fallback run never
    // leaks its ambient token here.
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
      ...(streamClosedTotal > 0
        ? { streamClosedCount: streamClosedTotal }
        : {}),
      ...(refreshedAuthSecret ? { refreshedAuthSecret } : {}),
    };
  }

  // ── Codex ─────────────────────────────────────────────────────────────────────────────────────

  private getCodex(
    sandboxKey: EngineHomeKey,
    auth: EngineAuth,
    bridge?: CodexMcpBridge,
    extraMcpServers?: CodexExtraMcpServers,
  ): Codex {
    const root = this.homeRoot();
    // Subscription-only: an overlay home owning its own auth.json (refreshed each turn) + — for an execute
    // turn — a config.toml with the host tool bridge (`[mcp_servers.atlasbridge]`) plus any user-defined
    // stdio MCP servers. The cache key keeps separate sandboxes apart. NO apiKey is ever passed.
    const codexHome = ensureCodexAuthHome(
      root,
      sandboxKey,
      auth.secret,
      bridge,
      extraMcpServers,
    );
    const cacheKey = `sub:${engineHomeKeyString(sandboxKey)}`;
    let client = this.codexClients.get(cacheKey);
    if (!client) {
      // The SDK's `env` REPLACES inheritance — pass process.env through and override CODEX_HOME.
      const env = { ...process.env, CODEX_HOME: codexHome } as Record<
        string,
        string
      >;
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
      // ALWAYS `danger-full-access` (NOT the default `workspace-write`, and NOT `read-only` even for the
      // plan-review turn). This is a disposable per-job sandbox, and every Codex turn needs the network:
      // execute turns bind a port for the live smoke + reach Postgres + `git push`, and read-only reviews
      // need to fetch live docs / verify library versions. `workspace-write` and `read-only` both FENCE the
      // network by default (→ `listen EPERM` / DB `EPERM` / DNS failures). The "don't edit files" contract
      // for review turns is carried by the PROMPT, not the sandbox — Codex has no `canUseTool` write guard
      // (unlike the Claude path), so the plan-review persona (`META_PLAN_REVIEW`) states it explicitly. This
      // matches the Claude builders, which already have full network + boot services + push.
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
      skipGitRepoCheck: true,
      webSearchMode: 'live',
      ...(model ? { model } : {}),
      // Codex ALWAYS runs at xhigh: default here so every Codex turn (current + any future thread-kind)
      // reasons hard regardless of callsite. Subscription accounts REJECT an explicit `model` but ACCEPT
      // this knob (verified by spike). A caller may still pass a lower explicit value if ever needed.
      modelReasoningEffort: reasoningEffort ?? 'xhigh',
    };
  }

  private async runCodex(
    args: RunEngineArgs,
    bridgeTools?: string[],
    extraMcpServers?: CodexExtraMcpServers,
  ): Promise<EngineRunResult> {
    const {
      task,
      cwd,
      systemPrompt,
      sandboxKey,
      sessionId,
      onEvent,
      signal,
      richStream,
    } = args;
    const auth = this.resolveAuth('codex', args.auth);
    // Pass through ONLY an explicit caller override (none today); otherwise leave unset so
    // `codexThreadOptions` omits `model` and the subscription account's default is used (see note above).
    const model = args.model;

    // Host tool bridge (execute turns only): render an `[mcp_servers.atlasbridge]` block into config.toml
    // pointing codex at the in-sandbox MCP server, which does the Redis round-trip to the host. The server
    // reads the turn's Redis streams from TURN_ID/REDIS_URL (set in the container by RedisEngineRunner).
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
    const opts = this.codexThreadOptions(
      cwd,
      model,
      toCodexEffort(args.modelReasoningEffort),
    );
    const thread = sessionId
      ? client.resumeThread(sessionId, opts)
      : client.startThread(opts);

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
            // NB: SDK session field — `thread.started` is the Agent SDK's own event and `thread_id` is its
            // session id (NOT our domain Job/Thread), so it is out of scope for the domain rename.
            resolvedSession = event.thread_id;
            // Surface the resume handle immediately (turn start) for mid-turn halt recovery.
            if (resolvedSession)
              onEvent?.({ kind: 'session', sessionId: resolvedSession });
            break;
          case 'item.completed': {
            const item = event.item;
            // Codex reports each item ONCE, already completed (with full command output / patch status), so
            // under `richStream` we emit the authoritative tool_use→tool_result pair back-to-back (the shared
            // TurnHarness pairs them by id) instead of the coarse `tool` event, which the durable transcript
            // drops. Without `richStream` (every current Codex caller) the coarse behavior is preserved.
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
                    item.status === 'failed' ||
                    (item.exit_code != null && item.exit_code !== 0);
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
                  // Codex bundles every file a patch touched into ONE item — split it into one
                  // tool_use/tool_result pair per file (mirroring Claude's one-file-per-Edit shape) so each
                  // gets its own diff card instead of a single card with no renderable content.
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
                      structuredPatch: computeCodexStructuredPatch(
                        cwd,
                        change.path,
                        change.kind,
                      ),
                    });
                  }
                } else {
                  onEvent?.({
                    kind: 'tool',
                    name: 'edit',
                    detail: item.changes
                      .map((c) => `${c.kind} ${c.path}`)
                      .join(', '),
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
      // 401 / expired creds mid-Codex-turn → resumable auth error carrying the live thread id.
      const msg = err instanceof Error ? err.message : String(err);
      if (isAuthErrorMessage(msg))
        throw new EngineAuthError(msg, resolvedSession, 'codex');
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

    // Auth-refresh write-back: Codex re-mints its short-lived tokens from the stored `refresh_token` and
    // rewrites `auth.json` in place. Read the overlay back and relay it so the host can persist the fresh
    // blob (else the stored credential is a rotting snapshot). Gated on `persistAuthRefresh` — the host
    // only sets it for ORG-sourced auth, so an env-fallback run never leaks its ambient token here.
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

// `addClaudeUsage`/`extractClaudeUsage` (usage accumulation/extraction) moved to `./engine-core/usage`.
// Re-exported here so this module's own callers/specs keep working unchanged.
export { addClaudeUsage, extractClaudeUsage } from './engine-core/usage';
