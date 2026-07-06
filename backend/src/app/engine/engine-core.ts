import type { CanUseTool, Options, PermissionResult, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Codex, FileChangeItem, ThreadOptions } from '@openai/codex-sdk';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { structuredPatch as diffStructuredPatch } from 'diff';
import { applyClaudeAuth } from './claude-auth';
import { atlasEngineHomeDir } from './engine-home';
import {
  assertValidCodexAuthJson,
  type CodexExtraMcpServers,
  type CodexMcpBridge,
  ensureCodexAuthHome,
  readCodexAuthHome,
} from './codex-auth-home';

/** In-container path of the bundled Codex MCP tool-bridge server (baked by the Dockerfile, bind-mounted
 *  live — see `sandbox/image/mcp-bridge-server.ts`). codex spawns it via the config.toml `command`. */
const CONTAINER_MCP_BRIDGE_PATH = '/usr/local/lib/atlas/mcp-bridge-server.mjs';
// Import from the DIRECT (Nest-free) assembly path, not the prompt-kit barrel — this module bundles into the
// in-container engine, and the barrel re-exports the NestJS PromptService/PromptKitModule.
import { renderAgentPrompt } from '../prompt-kit/assemble';
import { Agent } from '../prompt-kit/agent';
import { LSP_NAV_TOOL_NAMES, LSP_TOOL_NAMES, qualifyLspToolNames } from './lsp-tools';
import { context7Enabled, qualifyContext7ToolNames } from './context7-tools';
import {
  EngineAuthError,
  isAuthErrorMessage,
  UNRESUMABLE_SESSION_MARKER,
  type CodexReasoningEffort,
  type EngineAuth,
  type EngineRunResult,
  type EngineUsage,
  type ModelUsageBreakdown,
  type RunEngineArgs,
  type StructuredPatchHunk,
  resolveContextLimit,
} from './engine.types';

/**
 * Pull a well-formed `structuredPatch` (real file offsets) off an Edit/MultiEdit `tool_use_result`.
 * Returns undefined for any other tool, or when the shape doesn't match — so the caller simply omits it.
 */
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

/**
 * Codex's `file_change` item reports only `{ path, kind }` — never the before/after content the SDK
 * would need to hand us a diff (unlike Claude's Edit tool, which carries `old_string`/`new_string` and a
 * `structuredPatch` on its own tool result). Reconstruct one here: the last committed blob (`git show
 * HEAD:path`) stands in for "before" and the current on-disk file for "after". This is a `HEAD`-relative
 * diff, not a per-edit one — fine as long as the worktree isn't committed mid-turn (it isn't).
 */
function computeCodexStructuredPatch(cwd: string, path: string, kind: FileChangeItem['changes'][number]['kind']): StructuredPatchHunk[] | undefined {
  let oldContent = '';
  if (kind !== 'add') {
    try {
      oldContent = execFileSync('git', ['show', `HEAD:${path}`], { cwd, encoding: 'utf8' });
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
  const patch = diffStructuredPatch(path, path, oldContent, newContent, undefined, undefined, { context: 3 });
  return patch.hunks.length ? patch.hunks : undefined;
}

/** A user message the SDK's streaming input accepts (mid-turn steering uses `priority:'now'`). */
function steerUserMessage(content: string, priority?: 'now' | 'next' | 'later'): SDKUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
    ...(priority ? { priority } : {}),
  } as SDKUserMessage;
}

/**
 * A hand-driven async-iterable the engine feeds the SDK in STREAMING-INPUT mode: `push` a message to
 * deliver it to the live turn, `end` to close input so the query completes. Mirrors the spike harness.
 */
function makeManualInput(): {
  stream: AsyncIterable<SDKUserMessage>;
  push: (m: SDKUserMessage) => void;
  end: () => void;
} {
  const queue: SDKUserMessage[] = [];
  let resolveNext: ((r: IteratorResult<SDKUserMessage>) => void) | null = null;
  let done = false;
  return {
    push(m) {
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r({ value: m, done: false });
      } else queue.push(m);
    },
    end() {
      done = true;
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r({ value: undefined as never, done: true });
      }
    },
    stream: {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<SDKUserMessage>> {
            if (queue.length) return Promise.resolve({ value: queue.shift() as SDKUserMessage, done: false });
            if (done) return Promise.resolve({ value: undefined as never, done: true });
            return new Promise((res) => {
              resolveNext = res;
            });
          },
        };
      },
    },
  };
}

/**
 * After the model emits a `result` in streaming-input mode, wait this long for an in-flight steer to
 * arrive (Redis publish→subscribe latency) before closing the input and ending the turn. A no-steer turn
 * pays this as a small completion tail.
 */
const STEER_IDLE_GRACE_MS = 350;

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
 * an {@link EngineCoreConfig} (read from `EnvService` on the host, from `process.env` in the container),
 * and logging goes through a tiny {@link CoreLogger} (Nest Logger on the host, console in the container).
 */

/** Env-derived configuration (the values the host reads from EnvService, the container from process.env). */
export interface EngineCoreConfig {
  /** Root for the isolated agent home (from AGENT_HOME_ROOT). */
  homeRoot?: string;
  /**
   * Optional last-resort subscription secrets for when a run doesn't pass explicit `auth`. In practice every
   * turn threads its per-org secret as `args.auth`, so these stay unset in the real engine — they exist only
   * so `EngineCore` remains a self-contained, testable unit. There is NO ambient-env source for them.
   */
  claudeOauthToken?: string;
  codexOauthToken?: string;
}

/**
 * The agentic-engine model ids — CODE CONSTANTS, never env-configured (env vars are for per-environment
 * config; the model choice doesn't change across local/dev/staging/prod). A per-turn `args.model` still
 * overrides (e.g. the thread brain pins its own). The Claude id is the `'opus'` alias (auto-threads latest
 * Opus, like the brain); the Codex id is the Codex SDK's coding model.
 */
const DEFAULT_WORKER_MODEL = 'opus';
// NOTE: Codex runs subscription-only here — a ChatGPT-account OAuth token (see `resolveAuth`; there is no
// API-key path). A ChatGPT account REJECTS any explicit model with a 400 ("The '<model>' model is not
// supported when using Codex with a ChatGPT account"), including `gpt-5-codex` and `gpt-5`. So we do NOT
// pin a Codex model — we leave it unset and let the Codex SDK use the account's own default model.

/** A minimal logger so the core stays Nest-free. */
export interface CoreLogger {
  warn(message: string): void;
}

const NOOP_LOGGER: CoreLogger = { warn: () => undefined };

/**
 * Whether a resumable Claude session transcript exists under this config dir. The SDK stores it at
 * `<configDir>/projects/<cwd-slug>/<sessionId>.jsonl`; we scan the project dirs rather than recompute
 * the slug. Passing `resume` for a session whose transcript ISN'T here makes the SDK end the turn with a
 * generic `error_during_execution` — so we check first and raise a specific error instead.
 */
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

// Claude built-in tool sets. `tools` RESTRICTS the available set (unlike `allowedTools`, which only
// auto-approves).
// Web access: WebSearch runs server-side (no container egress needed); WebFetch runs client-side in
// the sandbox (the per-sandbox bridge network has NAT egress). Enabled on every turn so the engine can
// pull current docs / latest versions. This is a personal, trusted deployment — see `agents/web` notes.
const WEB_TOOLS = ['WebSearch', 'WebFetch'];
// Context7 (curated, version-pinned library docs) — see engine/context7-tools.ts. Gated on CONTEXT7_API_KEY:
// empty (the default) unless the deployment injects the key into the sandbox env, so `docs` sees these tools
// only when the remote server is actually registered (context7-bridge-options.ts), never a phantom name.
const CONTEXT7_TOOLS = context7Enabled() ? qualifyContext7ToolNames() : [];
// `Task` spawns a subagent — see SUBAGENTS below (read-only, Sonnet-pinned) for token-cheap exploration.
// The task tools (TaskCreate/TaskUpdate/TaskList/TaskGet — the SDK 0.3.x successors to the legacy
// TodoWrite) let the orchestrator maintain a LIVE task list as its visible decomposition; the navigator
// derives the per-thread checklist from these calls (see web `thread-todos.ts`). `tools` is an allowlist, so
// they must be named even though task-mode is default-on. They have no FS/git side effects.
const TASK_TOOLS = ['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'];
const WORKER_TOOLS = ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash', 'Task', ...TASK_TOOLS, ...WEB_TOOLS];
// A plan turn adds ExitPlanMode — native plan mode's turn-ender and the one place the FULL plan text
// reaches canUseTool headlessly (the CLI auto-writes the plan file, then calls ExitPlanMode with the
// plan in its input).
const PLAN_TOOLS = [...WORKER_TOOLS, 'ExitPlanMode'];
// A read-only review turn gets the read tools (+ web for verifying against current docs). No Task — a
// review turn shouldn't fan out.
const REVIEW_TOOLS = ['Read', 'Glob', 'Grep', 'Bash', ...WEB_TOOLS];
// Auto-approve safe reads, web, and subagent spawning; writes/bash fall through to canUseTool where the
// boundary is re-applied. Context7 docs tools (read-only, gated off by default) auto-approve too so the
// `docs` subagent never stalls on a permission prompt for them.
const AUTO_APPROVE = [
  'Read', 'Glob', 'Grep', 'Task', ...TASK_TOOLS, ...WEB_TOOLS, ...CONTEXT7_TOOLS,
];

// LSP navigation/rename (`atlas-lsp-ts`, registered per-turn — see sandbox/image/lsp-bridge-options.ts).
// Subagent `tools:` arrays are explicit, not inherited from the parent turn's `allowedTools`, so each
// subagent that should get these needs them listed here. Read-only investigators get navigation only
// (no `rename_symbol`); writers get the full set since they're the ones actually renaming things.
const LSP_NAV_TOOLS = qualifyLspToolNames(LSP_NAV_TOOL_NAMES);
const LSP_WRITE_TOOLS = qualifyLspToolNames(LSP_TOOL_NAMES);

// Subagent types the engine can spawn via `Task`. With `settingSources: []` there are NO on-disk agent
// definitions, so this map is the ONLY set of spawnable subagents — every subagent is Sonnet-pinned by
// construction (cheaper than the Opus brain). All are advisory: they investigate and report, and NONE
// can Write/Edit (only the calling turn changes files). `test` is the one exception to "read-only": it
// gets Bash so it can RUN the repo's verification, but it still cannot edit/commit. This keeps delegated
// work token-cheap and side-effect-free, while letting a worker push noisy test output off its context.
const SUBAGENTS: NonNullable<Options['agents']> = {
  explore: {
    description:
      'Read-only CODE explorer. Delegate investigation here — locating files, tracing how a ' +
      'feature works, mapping conventions — to keep the main context clean and save tokens. Returns a ' +
      'concise findings summary, not raw file dumps. Also handles the repo\'s OWN docs (CLAUDE.md, ' +
      'README, ARCHITECTURE.md, docs/). State the search breadth you want: "quick" (one targeted ' +
      'lookup), "medium" (moderate exploration), or "very thorough" (sweep multiple locations and ' +
      'naming conventions). For EXTERNAL library/framework/API documentation, use `docs` instead.',
    tools: ['Read', 'Glob', 'Grep', ...WEB_TOOLS, ...LSP_NAV_TOOLS],
    model: 'claude-sonnet-5',
    prompt: renderAgentPrompt(Agent.EXPLORE),
  },
  docs: {
    description:
      'External library/framework/API documentation researcher — answers "how do I use X" / "what\'s the ' +
      'current API for Y" from the LIBRARY\'S OWN docs on the web, not from this repo\'s source. Returns a ' +
      'synthesized, cited, version-aware answer. Use `explore` for how THIS codebase (and its own docs) ' +
      'work; use `docs` for third-party packages, frameworks, and external APIs.',
    tools: ['Read', 'Glob', 'Grep', ...WEB_TOOLS, ...CONTEXT7_TOOLS],
    model: 'claude-sonnet-5',
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
    prompt: renderAgentPrompt(Agent.REVIEW_AGENT),
  },
  debug: {
    description:
      'Read-only root-cause tracer. Give it a failure (error, stack trace, failing test, wrong ' +
      'behavior) and it traces the cause through the code and names the exact fix site and smallest fix ' +
      '— it does not run commands or change anything. Use `test` to actually run the verification.',
    tools: ['Read', 'Glob', 'Grep', ...WEB_TOOLS, ...LSP_NAV_TOOLS],
    model: 'claude-sonnet-5',
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
  'Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash', ...WEB_TOOLS, ...LSP_WRITE_TOOLS,
];
const WRITER_SUBAGENTS: NonNullable<Options['agents']> = {
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
    prompt: renderAgentPrompt(Agent.FAN_OUT),
  },
};

// VALIDATE subagent — build-time LIVE end-to-end validation + evidence capture. Added ONLY on EXECUTE
// turns (like the writers), so only the builder can spawn it. It gets `Bash` (to boot services via
// atlas-svc, curl endpoints, drive Playwright, run e2e) and `Write` (to author the `/context/artifacts/`
// evidence bundle + RESULTS.md — the `/context` mount is a writable root, see redis-engine-runner). It has
// NO `Task` (no recursive fan-out). Its "write only under /context/artifacts, don't edit code" contract is
// prompt discipline (the `canUseTool` write boundary is per-turn, not per-subagent) — same model as `test`
// being "read-only by prompt". Distinct from `test`: `test` runs typecheck/build/unit → a diagnosis;
// `validate` boots the thing, exercises it live, and leaves durable proof the operator can see.
const VALIDATE_SUBAGENT: NonNullable<Options['agents']> = {
  validate: {
    description:
      'LIVE validation + evidence capture (Sonnet). Delegate END-TO-END validation here to keep your ' +
      'context clean: it BOOTS the change and exercises it as a real caller would (atlas-svc services, ' +
      'curl, Playwright UI drives, the repo\'s own e2e/smoke), then leaves the PROOF in `/context/artifacts/` ' +
      '(logs, screenshots, a `RESULTS.md` index) that renders in the operator\'s ARTIFACTS panel. Returns a ' +
      'verdict + the observed behavior + the exact artifact paths it wrote — reference those instead of ' +
      'recapturing. Use `test` instead for a fast typecheck/build/unit diagnosis with no artifacts.',
    tools: ['Read', 'Glob', 'Grep', 'Bash', 'Write', ...WEB_TOOLS],
    model: 'claude-sonnet-5',
    prompt: renderAgentPrompt(Agent.VALIDATE),
  },
};

/** Is `path` inside `root` (after resolution)? Confines writes to the worktree. */
function isInsideRoot(path: string, root: string): boolean {
  const r = resolvePath(root);
  const p = resolvePath(root, path);
  return p === r || p.startsWith(r.endsWith('/') ? r : `${r}/`);
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

  /**
   * Resolve the run's subscription secret: an explicit `args.auth` wins (the host-resolved per-org
   * secret); otherwise fall back to the env-configured secret for this engine. There is NO api_key
   * path — a missing secret THROWS so the turn fails loudly instead of silently billing the API.
   */
  private resolveAuth(engine: 'claude' | 'codex', explicit: EngineAuth | undefined): EngineAuth {
    if (explicit) return explicit;
    const secret = engine === 'claude' ? this.cfg.claudeOauthToken : this.cfg.codexOauthToken;
    if (secret) return { secret };
    throw new Error(
      `No ${engine} subscription secret — the org has no ${engine} credential set (add one via ` +
        'onboarding, or `pnpm db:seed` in dev). The engine runs subscription-only (no API-key fallback).',
    );
  }

  async run(args: RunEngineArgs): Promise<EngineRunResult> {
    return this.stampUsageProvenance(
      await (args.engine === 'codex' ? this.runCodex(args) : this.runClaude(args)),
      args,
    );
  }

  /**
   * Stamp display-only provenance the engine paths don't carry themselves onto the returned usage: the
   * `engine` that ran (so a Codex turn with no `model` still labels as "Codex") and the `reasoningEffort`
   * the run was given (a Codex-only input, never surfaced by the SDK). Applied at BOTH dispatch wrappers
   * (`run` / `runWithExtras`) so every engine turn — build, Codex review, autofix — is covered without
   * touching `runClaude`/`runCodex` internals or any transcript `metaTag` call site. `??=` so a path that
   * ever populates these itself wins. No-op when the run produced no usage.
   */
  private stampUsageProvenance(res: EngineRunResult, args: RunEngineArgs): EngineRunResult {
    if (res.usage) {
      res.usage.engine ??= args.engine;
      if (args.modelReasoningEffort) res.usage.reasoningEffort ??= args.modelReasoningEffort;
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
   */
  async runWithExtras(
    args: RunEngineArgs,
    extraClaudeOptions?: Record<string, unknown>,
    bridgeToolNames?: string[],
    codexBridgeTools?: string[],
    codexExtraMcpServers?: CodexExtraMcpServers,
  ): Promise<EngineRunResult> {
    return this.stampUsageProvenance(
      await (args.engine === 'codex'
        ? this.runCodex(args, codexBridgeTools, codexExtraMcpServers)
        : this.runClaude(args, extraClaudeOptions, bridgeToolNames)),
      args,
    );
  }

  // ── Claude ────────────────────────────────────────────────────────────────────────────────────

  private async runClaude(
    args: RunEngineArgs,
    extraClaudeOptions?: Record<string, unknown>,
    bridgeToolNames?: string[],
  ): Promise<EngineRunResult> {
    const { task, cwd, systemPrompt, sandboxKey, sessionId, mode, onEvent, signal, richStream, steerInput } =
      args;

    const abortController = new AbortController();
    if (signal) {
      if (signal.aborted) abortController.abort();
      else signal.addEventListener('abort', () => abortController.abort(), { once: true });
    }

    // STREAMING-INPUT mode (the steerable brain turn): feed the SDK a live async-iterable that yields the
    // initial task, then drains `steerInput` (operator steers) with `priority:'now'`. The turn ends when the
    // model emits a `result` and no steer arrives within a short grace. Non-steerable turns keep the plain
    // string prompt (single-message mode) — zero behavior change for build/plan/review workers.
    const streaming = !!steerInput;
    const input = streaming ? makeManualInput() : undefined;
    let turnEnded = false;
    let endTimer: ReturnType<typeof setTimeout> | undefined;
    const cancelEnd = (): void => {
      if (endTimer) {
        clearTimeout(endTimer);
        endTimer = undefined;
      }
    };
    const scheduleEnd = (): void => {
      if (!input) return;
      cancelEnd();
      endTimer = setTimeout(() => input.end(), STEER_IDLE_GRACE_MS);
    };
    const steerIter = streaming ? steerInput![Symbol.asyncIterator]() : undefined;
    // A priority:'now' steer pushed BEFORE the model commits its first assistant message makes the SDK
    // abort the whole turn (result_type=user, terminal_reason=aborted_streaming, subtype=error_during_
    // execution) — the startup-race red box. So a steer that arrives while the turn is still spinning up is
    // HELD in `steerBuffer` and flushed the instant the first `assistant` message lands (`streamingStarted`),
    // at which point a mid-turn steer injects cleanly (subtype=success, steer honored). Verified by spike.
    let streamingStarted = false;
    const steerBuffer: Array<{ id?: string; text: string }> = [];
    let flushSteerBuffer = (): void => {}; // real impl set below when streaming; no-op for worker turns
    if (input) {
      input.push(steerUserMessage(task));
      // Drain operator steers into the live turn until the turn ends. Each steer carries its stimulus `id`;
      // we push it into the session with priority:'now', then emit an `input_ack` echoing the id — the
      // durable proof the message was TAKEN (the host stamps delivered_at only on this ack, never on the
      // stream write). A redelivered id (a lost ack re-driven by the delivery pump) is a NO-OP push
      // (exactly-once injection) but STILL re-emits its ack so delivery converges. A steer held pre-stream
      // is NOT acked until it is actually injected (on flush), so a turn that dies before first content
      // leaves the message pending (delivered_at null) for the sweep — no acked-but-dropped message.
      const injectedSteerIds = new Set<string>();
      const bufferedIds = new Set<string>();
      const injectSteer = (id: string | undefined, text: string): void => {
        cancelEnd(); // a steer is in flight to the model — don't close input under it
        input.push(steerUserMessage(text, 'now'));
        if (typeof id === 'string') {
          injectedSteerIds.add(id);
          onEvent?.({ kind: 'input_ack', id });
        }
      };
      flushSteerBuffer = (): void => {
        while (steerBuffer.length) {
          const s = steerBuffer.shift()!;
          injectSteer(s.id, s.text);
        }
      };
      void (async () => {
        try {
          while (!turnEnded && steerIter) {
            const { value, done } = await steerIter.next();
            if (done || turnEnded) break;
            const text = value?.text;
            if (typeof text !== 'string' || text.length === 0) continue;
            const id = value?.id;
            if (typeof id === 'string' && injectedSteerIds.has(id)) {
              // Re-delivered after a lost ack — re-emit the ack so delivery converges; never re-push.
              onEvent?.({ kind: 'input_ack', id });
              continue;
            }
            if (typeof id === 'string' && bufferedIds.has(id)) continue; // already held (not yet taken → no ack)
            if (!streamingStarted) {
              steerBuffer.push({ id, text }); // HOLD until first assistant message (see note above)
              if (typeof id === 'string') bufferedIds.add(id);
              continue;
            }
            injectSteer(id, text);
          }
        } catch {
          /* steer source closed — the turn's own lifecycle ends it */
        }
      })();
    }

    const auth = this.resolveAuth('claude', args.auth);
    const model = args.model ?? DEFAULT_WORKER_MODEL;

    // Pin the SDK subprocess to Atlas's ISOLATED config/state home — never ~/.claude.
    const claudeConfigDir = atlasEngineHomeDir(this.homeRoot(), 'claude', sandboxKey);

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
    };
    applyClaudeAuth(subprocessEnv, auth);

    // Capture the CLI subprocess's stderr (the real API/transport error text) into a bounded ring
    // buffer so a non-success result can surface it — the SDK otherwise flattens it into `subtype`.
    const stderrTail: string[] = [];
    const captureStderr = (data: string) => {
      stderrTail.push(data);
      if (stderrTail.length > 40) stderrTail.shift(); // keep the last ~40 chunks
    };

    const options: Options = {
      cwd,
      systemPrompt,
      // No skills: settingSources [] means NO on-disk config files are read (full isolation).
      settingSources: [],
      tools: planMode ? PLAN_TOOLS : readOnly ? REVIEW_TOOLS : WORKER_TOOLS,
      // Programmatic subagent definitions (settingSources [] means none are read from disk) — the only
      // spawnable Task subagents. Advisory subagents (read-only, Sonnet) are always available; the WRITER
      // subagents (implement/implement-deep) and the build-time VALIDATE subagent are added ONLY on EXECUTE
      // turns, so a plan/brain/review turn can never fan out a file-mutating or evidence-writing subagent.
      // See SUBAGENTS / WRITER_SUBAGENTS / VALIDATE_SUBAGENT.
      agents:
        mode === 'execute'
          ? { ...SUBAGENTS, ...WRITER_SUBAGENTS, ...VALIDATE_SUBAGENT }
          : SUBAGENTS,
      // Host-side tools reach the in-sandbox session as an MCP server (the tool bridge). Surface
      // their qualified names (`mcp__<server>__<tool>`) in allowedTools so they're auto-approved —
      // they're host-controlled, never a human prompt. Empty for non-bridge turns (workers).
      allowedTools: [...AUTO_APPROVE, ...(bridgeToolNames ?? [])],
      canUseTool: makeCanUseTool(readOnly, [cwd, ...(args.writableRoots ?? [])], (plan) => {
        capturedPlan = plan;
      }),
      permissionMode: planMode ? 'plan' : 'default',
      // Suppress the SDK's default "Co-Authored-By: Claude" attribution.
      settings: { attribution: { commit: '', pr: '' } },
      abortController,
      env: subprocessEnv,
      // The SDK routes the Claude Code subprocess's stderr here (the real API/transport error the
      // `error_during_execution` subtype otherwise hides). Unconditional: worker turns fail too.
      stderr: captureStderr,
      ...(sessionId ? { resume: sessionId } : {}),
      ...(model ? { model } : {}),
      // Enable the 1M-token context window explicitly. Opus 4.x and Sonnet 5 negotiate it automatically, but
      // we pass the beta as belt-and-suspenders so a builder session that fills past 200k does NOT truncate —
      // Leg rotation's HARD threshold (200k) depends on there being headroom ABOVE it to author the handoff
      // (see the context-rot plan). The SDK forwards `anthropic-beta: context-1m-2025-08-07`.
      betas: ['context-1m-2025-08-07'],
      // Rich streaming (the thread brain): partial-message stream → token-level deltas, and extended
      // thinking → thinking blocks. Adaptive lets Claude decide thinking depth per turn.
      // forwardSubagentText: forward a subagent's FULL text+thinking (not just its tool calls) tagged with
      // `parent_tool_use_id`, so the brain turn can render each subagent run as its own nested transcript.
      ...(richStream
        ? {
            includePartialMessages: true,
            // `display: 'summarized'` is load-bearing: without it the adaptive default is `omitted`, which
            // streams thinking blocks with EMPTY text — the `&& block.thinking` guards below then drop them,
            // so nothing is ever emitted or persisted. Summarized surfaces the reasoning for debugging.
            thinking: { type: 'adaptive' as const, display: 'summarized' as const },
            forwardSubagentText: true,
          }
        : {}),
      // R1 tool-bridge: optional extra options (e.g. mcpServers) from the in-container entrypoint.
      ...(extraClaudeOptions ?? {}),
    } as Options;

    let result = '';
    let resolvedSession = sessionId;
    let usage: EngineUsage | undefined;
    // Live context-window occupancy (distinct from the cumulative billing total): each `assistant`
    // message is ONE model round-trip whose own `usage` reports the input size of THAT call (fresh +
    // cache read + cache creation) — the real context size at that moment. We keep the MAIN agent's
    // LAST round-trip (turn-end occupancy) + its model. Subagent messages (parent_tool_use_id set) run
    // in their OWN context on cheaper models, so they're excluded.
    let contextTokens: number | undefined;
    let contextModel: string | undefined;
    try {
      for await (const message of this.claudeSdk.query({
        prompt: streaming ? input!.stream : task,
        options,
      })) {
        // Model is actively producing (or a steer is being processed) → don't close input under it.
        if (streaming && message.type !== 'result') cancelEnd();
        if (message.type === 'system' && message.subtype === 'init') {
          resolvedSession = message.session_id;
          // Surface the resume handle the instant the session exists, so a mid-turn halt is recoverable.
          if (resolvedSession) onEvent?.({ kind: 'session', sessionId: resolvedSession });
        } else if (richStream && message.type === 'stream_event') {
          // LIVE token-by-token deltas (partial-message stream). Authoritative full blocks still arrive
          // on the `assistant` message below — these are for live rendering only, not persistence. Carry
          // the subagent parent id (same as the authoritative blocks) so live nested rendering matches.
          const sev = message as {
            parent_tool_use_id?: string | null;
            event?: { type?: string; delta?: { type?: string; text?: string; thinking?: string } };
          };
          const parent = sev.parent_tool_use_id ?? undefined;
          const sub = parent ? { parentToolUseId: parent } : {};
          const ev = sev.event;
          if (ev?.type === 'content_block_delta') {
            if (ev.delta?.type === 'text_delta' && ev.delta.text)
              onEvent?.({ kind: 'text_delta', text: ev.delta.text, ...sub });
            else if (ev.delta?.type === 'thinking_delta' && ev.delta.thinking)
              onEvent?.({ kind: 'thinking_delta', text: ev.delta.thinking, ...sub });
          }
        } else if (message.type === 'assistant') {
          // First committed assistant message ⇒ the turn is genuinely streaming: a held steer can now inject
          // with priority:'now' without aborting the turn. Flush the pre-stream hold buffer (no-op after the
          // first message / for turns that never held anything). Must be an `assistant` message, NOT a
          // stream_event content delta — flushing on a partial delta still aborts (verified by spike).
          if (!streamingStarted) {
            streamingStarted = true;
            flushSteerBuffer();
          }
          // `parent_tool_use_id` is UNSET for the brain's own blocks, SET to the spawning Task id for a
          // subagent's blocks (forwardSubagentText forwards subagent text/thinking the same way).
          const parent = message.parent_tool_use_id ?? undefined;
          const sub = parent ? { parentToolUseId: parent } : {};
          // Context occupancy: only the MAIN agent's round-trips (parent unset). This message's OWN
          // usage is the single-call input size (NOT the cumulative turn total) — keep the latest as
          // the turn-end occupancy, with the call's model so the ring resolves the right window.
          if (!parent) {
            const amsg = (message as { message?: { model?: string; usage?: {
              input_tokens?: number;
              cache_read_input_tokens?: number;
              cache_creation_input_tokens?: number;
            } } }).message;
            const cu = amsg?.usage;
            if (cu) {
              contextTokens =
                (cu.input_tokens ?? 0) + (cu.cache_read_input_tokens ?? 0) + (cu.cache_creation_input_tokens ?? 0);
              if (amsg?.model) contextModel = amsg.model;
              // Emit the occupancy LIVE so the composer ring fills mid-turn (a turn can run for minutes). Fires
              // once per main-agent round-trip; the turn-end `turn_meta` remains the durable authority.
              onEvent?.({
                kind: 'usage',
                contextTokens,
                ...(contextModel ? { contextModel } : {}),
                contextLimit: resolveContextLimit(contextModel),
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
              onEvent?.({ kind: 'text', text: block.text, ...sub });
            } else if (block.type === 'thinking' && block.thinking) {
              if (richStream) onEvent?.({ kind: 'thinking', text: block.thinking, ...sub });
            } else if (block.type === 'tool_use' && block.name) {
              // Rich turns get the full tool call (id + input) so the UI can render it; coarse turns keep
              // the legacy name-only `tool` event.
              if (richStream)
                onEvent?.({ kind: 'tool_use', id: block.id ?? '', name: block.name, input: block.input, ...sub });
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
              if (block.type === 'tool_result')
                onEvent?.({
                  kind: 'tool_result',
                  id: block.tool_use_id ?? '',
                  result: block.content,
                  isError: block.is_error,
                  ...(patch ? { structuredPatch: patch } : {}),
                  ...sub,
                });
            }
          }
        } else if (message.type === 'result') {
          resolvedSession = message.session_id;
          if (message.subtype === 'success') {
            result = message.result;
            usage = extractClaudeUsage(message as Record<string, unknown>, model);
            // Attach the per-call context occupancy (+ its model) onto the billing usage. The cumulative
            // `inputTokens` stays the billing number; `contextTokens` is the real window occupancy.
            if (usage && contextTokens !== undefined) {
              usage.contextTokens = contextTokens;
              if (contextModel) usage.contextModel = contextModel;
            }
            // Streaming-input mode: the model finished responding but the query stays alive awaiting more
            // input. Close it after a short grace unless a steer lands (which cancels the timer). Single-
            // message mode ends naturally when the generator closes.
            if (streaming) scheduleEnd();
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
              r.terminal_reason ? `terminal_reason=${JSON.stringify(r.terminal_reason)}` : '',
              r.errors?.length ? `errors=${r.errors.join(' | ')}` : '',
              stderrTail.length ? `stderr(tail)=${stderrTail.join('').slice(-2000)}` : '',
            ].filter(Boolean);
            throw new Error(parts.join('; '));
          }
        }
      }
    } catch (err) {
      // A 401 / expired token / "not logged in" → a RESUMABLE auth error carrying the live session,
      // so the driver pauses (not fails) and a re-ping continues this same session. Else re-throw.
      const msg = err instanceof Error ? err.message : String(err);
      if (isAuthErrorMessage(msg)) throw new EngineAuthError(msg, resolvedSession);
      // Cooperative STOP of a STEERABLE turn (operator Stop): the SDK iterator was cancelled. Treat as a
      // graceful end — fall through to the normal post-loop return with the partial result + live session,
      // so the turn finalizes cleanly (partial transcript persisted, session resumable) rather than
      // erroring. Non-streaming worker turns keep throwing on abort (the driver's timeout race depends on it).
      if (!(streaming && abortController.signal.aborted)) throw err;
    } finally {
      // Stop feeding/consuming input so the detached steer consumer + entrypoint generator unwind.
      turnEnded = true;
      cancelEnd();
      input?.end();
      void steerIter?.return?.(undefined);
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

  private getCodex(
    sandboxKey: string,
    auth: EngineAuth,
    bridge?: CodexMcpBridge,
    extraMcpServers?: CodexExtraMcpServers,
  ): Codex {
    const root = this.homeRoot();
    // Subscription-only: an overlay home owning its own auth.json (refreshed each turn) + — for an execute
    // turn — a config.toml with the host tool bridge (`[mcp_servers.atlasbridge]`) plus any user-defined
    // stdio MCP servers. The cache key keeps separate sandboxes apart. NO apiKey is ever passed.
    const codexHome = ensureCodexAuthHome(root, sandboxKey, auth.secret, bridge, extraMcpServers);
    const cacheKey = `sub:${sandboxKey}`;
    let client = this.codexClients.get(cacheKey);
    if (!client) {
      // The SDK's `env` REPLACES inheritance — pass process.env through and override CODEX_HOME.
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
      // Subscription accounts REJECT an explicit `model` but ACCEPT this knob (verified by spike) — the
      // plan-review turn pins `'xhigh'` so the reviewer reasons hard.
      ...(reasoningEffort ? { modelReasoningEffort: reasoningEffort } : {}),
    };
  }

  private async runCodex(
    args: RunEngineArgs,
    bridgeTools?: string[],
    extraMcpServers?: CodexExtraMcpServers,
  ): Promise<EngineRunResult> {
    const { task, cwd, systemPrompt, sandboxKey, sessionId, onEvent, signal, richStream } = args;
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
            env: { TURN_ID: turnId, REDIS_URL: process.env.REDIS_URL ?? 'redis://redis:6379' },
          }
        : undefined;

    const client = this.getCodex(sandboxKey, auth, bridge, extraMcpServers);
    const opts = this.codexThreadOptions(cwd, model, args.modelReasoningEffort);
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
          // NB: SDK session field — `thread.started` is the Agent SDK's own event and `thread_id` is its
          // session id (NOT our domain Job/Thread), so it is out of scope for the domain rename.
          resolvedSession = event.thread_id;
          // Surface the resume handle immediately (turn start) for mid-turn halt recovery.
          if (resolvedSession) onEvent?.({ kind: 'session', sessionId: resolvedSession });
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
                onEvent?.({ kind: 'tool_use', id: item.id, name: 'bash', input: { command: item.command } });
                onEvent?.({ kind: 'tool_result', id: item.id, result: item.aggregated_output, isError });
              } else {
                onEvent?.({ kind: 'tool', name: 'bash', detail: item.command });
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
                onEvent?.({ kind: 'tool_use', id: item.id, name: 'web_search', input: { query: item.query } });
                onEvent?.({ kind: 'tool_result', id: item.id, result: 'completed' });
              } else {
                onEvent?.({ kind: 'tool', name: 'web_search', detail: item.query });
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

    // Auth-refresh write-back: Codex re-mints its short-lived tokens from the stored `refresh_token` and
    // rewrites `auth.json` in place. Read the overlay back and relay it so the host can persist the fresh
    // blob (else the stored credential is a rotting snapshot). Gated on `persistAuthRefresh` — the host
    // only sets it for ORG-sourced auth, so an env-fallback run never leaks its ambient token here.
    const refreshedAuthSecret = args.persistAuthRefresh
      ? this.readBackCodexRefresh(sandboxKey, auth.secret)
      : undefined;

    return {
      result: summary,
      sessionId: resolvedSession ?? thread.id ?? undefined,
      ...(usage ? { usage } : {}),
      ...(refreshedAuthSecret ? { refreshedAuthSecret } : {}),
    };
  }

  /**
   * Read the Codex overlay `auth.json` back after a turn and return it ONLY when it changed from what we
   * wrote (a real token refresh) AND still parses as a valid auth.json. Best-effort: any failure returns
   * `undefined` (never fail the turn, never propagate a corrupt overlay). Cheap string compare → no-op on
   * the common path where Codex didn't refresh.
   */
  private readBackCodexRefresh(sandboxKey: string, writtenSecret: string): string | undefined {
    try {
      const after = readCodexAuthHome(this.homeRoot(), sandboxKey);
      if (!after || after === writtenSecret) return undefined;
      assertValidCodexAuthJson(JSON.parse(after));
      return after;
    } catch (err) {
      this.logger.warn(`codex auth-refresh readback skipped: ${err instanceof Error ? err.message : err}`);
      return undefined;
    }
  }
}

/** Re-applies the safety boundary to Claude's built-in tools (programmatic gate — never blocks on a
 * human). A 'plan' turn runs under the SDK's native plan mode (the CLI itself enforces read-only);
 * ExitPlanMode's input carries the plan, which we capture then DENY (approving would flip the live
 * session into execution). The Write/Edit/bash read-only branches are belt-and-braces.
 *
 * `roots` is the set of directories Write/Edit may target (the worktree `cwd` plus any extra writable
 * mounts like the durable `/context` shared folder). A write is allowed if it lands inside ANY root. */
export function makeCanUseTool(
  readOnly: boolean,
  roots: string | string[],
  onPlan: (plan: string) => void,
): CanUseTool {
  const allowedRoots = (Array.isArray(roots) ? roots : [roots]).filter(Boolean);
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
      if (path && !allowedRoots.some((root) => isInsideRoot(path, root))) {
        return {
          behavior: 'deny',
          message: `Write outside the allowed roots (${allowedRoots.join(', ')}) is not allowed: ${path}`,
        };
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
  // The SDK's per-model breakdown for the WHOLE turn (orchestrator + subagents), keyed by model id.
  // Formerly collapsed to `Object.keys(...)[0]` (dropping every model but the first); now carried in
  // full onto `usage.modelUsage` as the authoritative source for per-model token/cost analytics.
  const rawModelUsage = message.modelUsage as
    | Record<
        string,
        {
          inputTokens?: number;
          outputTokens?: number;
          cacheReadInputTokens?: number;
          cacheCreationInputTokens?: number;
          costUSD?: number;
          webSearchRequests?: number;
        }
      >
    | undefined;
  const modelUsage: Record<string, ModelUsageBreakdown> | undefined = rawModelUsage
    ? Object.fromEntries(
        Object.entries(rawModelUsage).map(([m, mu]) => [
          m,
          {
            inputTokens: mu.inputTokens ?? 0,
            outputTokens: mu.outputTokens ?? 0,
            cacheReadTokens: mu.cacheReadInputTokens ?? 0,
            cacheWriteTokens: mu.cacheCreationInputTokens ?? 0,
            costUsd: mu.costUSD ?? 0,
            ...(mu.webSearchRequests ? { webSearchRequests: mu.webSearchRequests } : {}),
          },
        ]),
      )
    : undefined;
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
    ...(modelUsage ? { modelUsage } : {}),
  };
}
