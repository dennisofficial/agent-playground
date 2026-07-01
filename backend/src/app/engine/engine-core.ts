import type { CanUseTool, Options, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { Codex, ThreadOptions } from '@openai/codex-sdk';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { applyClaudeAuth } from './claude-auth';
import { atlasEngineHomeDir } from './engine-home';
import { ensureCodexAuthHome } from './codex-auth-home';
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
  /** Root for the isolated agent home (AGENT_HOME_ROOT ?? AGENT_HOME_ROOT). */
  homeRoot?: string;
  /** Subscription OAuth token for Claude when a run doesn't pass explicit `auth` (CLAUDE_OAUTH_TOKEN). */
  claudeOauthToken?: string;
  /** Subscription secret (auth.json / token) for Codex when a run doesn't pass explicit `auth` (CODEX_OAUTH_TOKEN). */
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
// boundary is re-applied.
const AUTO_APPROVE = ['Read', 'Glob', 'Grep', 'Task', ...TASK_TOOLS, ...WEB_TOOLS];

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
    tools: ['Read', 'Glob', 'Grep', ...WEB_TOOLS],
    model: 'sonnet',
    prompt:
      'You are a read-only exploration subagent. Investigate exactly what you were asked and return a ' +
      'tight, factual summary: the relevant file paths (with line numbers where useful), how the ' +
      'pieces fit together, and the specific answer to the question. Use Read/Glob/Grep to search the ' +
      'repo and WebSearch/WebFetch for external docs, and fire multiple searches in parallel rather ' +
      'than one at a time. Scale your effort to the breadth the caller asked for — "quick" is a single ' +
      'targeted lookup, "medium" is moderate exploration, "very thorough" sweeps multiple locations and ' +
      'naming conventions. Do NOT propose changes or write files — report findings only. Be concise; ' +
      'the caller wants conclusions, not transcripts.',
  },
  docs: {
    description:
      'External library/framework/API documentation researcher — answers "how do I use X" / "what\'s the ' +
      'current API for Y" from the LIBRARY\'S OWN docs on the web, not from this repo\'s source. Returns a ' +
      'synthesized, cited, version-aware answer. Use `explore` for how THIS codebase (and its own docs) ' +
      'work; use `docs` for third-party packages, frameworks, and external APIs.',
    tools: ['Read', 'Glob', 'Grep', ...WEB_TOOLS],
    model: 'sonnet',
    prompt:
      'You are a read-only documentation research subagent for EXTERNAL libraries, frameworks, and APIs. ' +
      'Answer from the official/third-party documentation via WebSearch/WebFetch — current versions, ' +
      'syntax, configuration, migration notes, CLI usage. Read the repo ONLY to ground the answer in ' +
      "what's actually installed (the version in package.json / the lockfile, how the package is already " +
      'imported) so your answer matches the version in use — do NOT answer the question from this repo\'s ' +
      'source. Synthesize a direct answer, quote the exact API/signature/config, and cite the URL (and ' +
      'the version it applies to). Flag where the docs lag the installed version or are ambiguous. Do ' +
      'NOT propose changes or write files — report findings only. Be concise: the answer plus its sources.',
  },
  review: {
    description:
      'Read-only code reviewer. Hand it a diff (or changed files) plus the intent, and it returns ' +
      'concrete findings — correctness bugs, behavior silently removed, convention/altitude drift, ' +
      'missing edge cases — grounded in the surrounding code. A cheap second pair of eyes before a step ' +
      'is called done. It reports; it does NOT fix.',
    tools: ['Read', 'Glob', 'Grep', ...WEB_TOOLS],
    model: 'sonnet',
    prompt:
      'You are a read-only code-review subagent. You are given changed code (a diff or file list) and ' +
      'the intent behind it. Review skeptically against the real surrounding code: find correctness ' +
      'bugs, behavior the change silently removed or broke, violations of the conventions this codebase ' +
      'already follows, and missing edge cases or error handling. Read the neighboring code to ground ' +
      'EVERY finding — do not guess. Report each finding on its own line as `file:line — what is wrong ' +
      'and why it matters`, most severe first; if the change is clean, say so plainly. Do NOT edit ' +
      'files — report findings only.',
  },
  debug: {
    description:
      'Read-only root-cause tracer. Give it a failure (error, stack trace, failing test, wrong ' +
      'behavior) and it traces the cause through the code and names the exact fix site and smallest fix ' +
      '— it does not run commands or change anything. Use `test` to actually run the verification.',
    tools: ['Read', 'Glob', 'Grep', ...WEB_TOOLS],
    model: 'sonnet',
    prompt:
      'You are a read-only debugging subagent. Given a failure — an error message, stack trace, failing ' +
      'test, or described misbehavior — trace it to its ROOT CAUSE by reading the code paths involved ' +
      '(follow the stack, the data flow, the call sites). Use the web to check library behavior when ' +
      'relevant. Return: the root cause in one or two sentences, the exact `file:line` where the fix ' +
      'belongs, and the smallest change that would fix it (described, not applied). Distinguish what you ' +
      'PROVED from what you merely suspect. Do NOT run commands or edit files — diagnose and report only.',
  },
  test: {
    description:
      "Runs the repository's verification (typecheck/build/lint/tests) in the worktree and returns a " +
      'DIAGNOSIS, not raw logs — pass/fail per command, and for failures the specific errors and likely ' +
      'cause. Keeps thousands of lines of test output out of your context. It can run commands (Bash) ' +
      'but does NOT edit files or change git state.',
    tools: ['Read', 'Glob', 'Grep', 'Bash', ...WEB_TOOLS],
    model: 'sonnet',
    prompt:
      "You are a verification subagent. Discover and run the repository's OWN typecheck/build/lint/test " +
      'tooling for the change or area you were asked to verify — read package.json scripts / Makefile / ' +
      'the repo docs to find the REAL commands, do not assume them — using Bash. Then return a TIGHT ' +
      'diagnosis, NOT the raw output: for each command, the command and whether it passed or failed; for ' +
      'failures, the specific failing tests/errors and the most likely cause, with `file:line` where you ' +
      'can locate it. Run read-only verification only — do NOT edit files, commit, or change git state. ' +
      'Be concise; the caller wants the verdict and the actionable failures, not the transcript.',
  },
};

// WRITER subagents — the ONLY subagents that can change files. Added to the spawnable set ONLY on
// EXECUTE turns (see `run`), so an advisory plan/brain/review turn can NEVER fan out a file-mutating
// subagent. Confinement: their Write/Edit go through the SAME global `canUseTool` worktree boundary as
// the orchestrator's own writes; Bash is bounded by the per-thread Docker sandbox (the engine runs
// boxed). They have NO `Task` tool — writers cannot recursively fan out (no nesting blowup). The
// orchestrator owns the decomposition and runs writers ONE AT A TIME; file ownership between writers is
// by serialization, not a hard lock (see ORCHESTRATE_EXECUTE_SYSTEM in the driver).
const WRITER_TOOLS = ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash', ...WEB_TOOLS];
const WRITER_PROMPT =
  'You are an implementation subagent. Implement EXACTLY the slice the orchestrator assigned — the ' +
  'specific change to the specific files it named — and nothing else. Respect the locked decisions. ' +
  'Stay strictly within the files you were told to touch: if the work genuinely needs a file outside ' +
  'that set, STOP and report it rather than editing it (the orchestrator coordinates who owns what). ' +
  'Always Read a file before you Edit it. If you make ANY change not called for by your assignment, ' +
  "flag it on its own line starting with 'DEVIATION:' and a one-line why. When you finish, return a " +
  'TIGHT summary — the files you changed and the key choices — NOT a transcript or the full diff. Do ' +
  'NOT commit or otherwise change git state; the orchestrator integrates, verifies, and commits.';
const WRITER_SUBAGENTS: NonNullable<Options['agents']> = {
  implement: {
    description:
      'WRITER subagent (Opus) — delegate a concrete implementation slice here (e.g. "create file X ' +
      'implementing …", "add method Y to Z per the brief"), NAMING the exact files it may touch. It ' +
      'edits the worktree and returns a tight summary of what it changed. Use it for non-trivial code ' +
      'that needs judgment. Run ONE writer at a time. For mechanical, fully-specified slices use ' +
      '`implement-fast` instead (cheaper).',
    tools: WRITER_TOOLS,
    model: 'opus',
    prompt: WRITER_PROMPT,
  },
  'implement-fast': {
    description:
      'WRITER subagent (Sonnet) — the cheaper/faster sibling of `implement` for MECHANICAL, ' +
      'fully-specified slices (rote edits, boilerplate, repetitive changes with no design judgment ' +
      'left to make). Same rules: it edits only the files you name and returns a tight summary; run ' +
      'one writer at a time.',
    tools: WRITER_TOOLS,
    model: 'sonnet',
    prompt: WRITER_PROMPT,
  },
};

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

  /**
   * Resolve the run's subscription secret: an explicit `args.auth` wins (the host-resolved per-org
   * secret); otherwise fall back to the env-configured secret for this engine. There is NO api_key
   * path — a missing secret THROWS so the turn fails loudly instead of silently billing the API.
   */
  private resolveAuth(engine: 'claude' | 'codex', explicit: EngineAuth | undefined): EngineAuth {
    if (explicit) return explicit;
    const secret = engine === 'claude' ? this.cfg.claudeOauthToken : this.cfg.codexOauthToken;
    if (secret) return { secret };
    const envVar = engine === 'claude' ? 'CLAUDE_OAUTH_TOKEN' : 'CODEX_OAUTH_TOKEN';
    throw new Error(
      `No ${engine} subscription secret — set a per-org secret or ${envVar}. ` +
        'The engine runs subscription-only (no API-key fallback).',
    );
  }

  async run(args: RunEngineArgs): Promise<EngineRunResult> {
    return args.engine === 'codex' ? this.runCodex(args) : this.runClaude(args);
  }

  /**
   * Like `run`, but passes extra Claude SDK options (e.g. `mcpServers` for the tool bridge) plus the
   * bridge's MCP tool names. Used by the in-container entrypoint when the tool-bridge is active; the
   * host `EngineRunner` calls the plain `run` path (the bridge is wired host-side there).
   *
   * `extraClaudeOptions` is spread verbatim into the SDK `Options` — pass `{ mcpServers }`, NOT the
   * raw server map, or the server lands as a stray top-level key and never registers.
   * `bridgeToolNames` are the qualified `mcp__<server>__<tool>` names to auto-approve.
   */
  async runWithExtras(
    args: RunEngineArgs,
    extraClaudeOptions?: Record<string, unknown>,
    bridgeToolNames?: string[],
  ): Promise<EngineRunResult> {
    return args.engine === 'codex'
      ? this.runCodex(args)
      : this.runClaude(args, extraClaudeOptions, bridgeToolNames);
  }

  // ── Claude ────────────────────────────────────────────────────────────────────────────────────

  private async runClaude(
    args: RunEngineArgs,
    extraClaudeOptions?: Record<string, unknown>,
    bridgeToolNames?: string[],
  ): Promise<EngineRunResult> {
    const { task, cwd, systemPrompt, sandboxKey, sessionId, mode, onEvent, signal, richStream } = args;

    const abortController = new AbortController();
    if (signal) {
      if (signal.aborted) abortController.abort();
      else signal.addEventListener('abort', () => abortController.abort(), { once: true });
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

    const options: Options = {
      cwd,
      systemPrompt,
      // No skills: settingSources [] means NO on-disk config files are read (full isolation).
      settingSources: [],
      tools: planMode ? PLAN_TOOLS : readOnly ? REVIEW_TOOLS : WORKER_TOOLS,
      // Programmatic subagent definitions (settingSources [] means none are read from disk) — the only
      // spawnable Task subagents. Advisory subagents (read-only, Sonnet) are always available; the WRITER
      // subagents (implement/implement-fast) are added ONLY on EXECUTE turns, so a plan/brain/review turn
      // can never fan out a file-mutating subagent. See SUBAGENTS / WRITER_SUBAGENTS.
      agents: mode === 'execute' ? { ...SUBAGENTS, ...WRITER_SUBAGENTS } : SUBAGENTS,
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
      ...(sessionId ? { resume: sessionId } : {}),
      ...(model ? { model } : {}),
      // Rich streaming (the thread brain): partial-message stream → token-level deltas, and extended
      // thinking → thinking blocks. Adaptive lets Claude decide thinking depth per turn.
      // forwardSubagentText: forward a subagent's FULL text+thinking (not just its tool calls) tagged with
      // `parent_tool_use_id`, so the brain turn can render each subagent run as its own nested transcript.
      ...(richStream
        ? { includePartialMessages: true, thinking: { type: 'adaptive' as const }, forwardSubagentText: true }
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
      for await (const message of this.claudeSdk.query({ prompt: task, options })) {
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
    // Subscription-only: an overlay home owning its own auth.json (refreshed each turn). The cache key
    // keeps separate sandboxes apart. NO apiKey is ever passed — the CLI reads auth.json from CODEX_HOME.
    const codexHome = ensureCodexAuthHome(root, sandboxKey, auth.secret);
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
    readOnly: boolean,
    reasoningEffort?: CodexReasoningEffort,
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
      // Subscription accounts REJECT an explicit `model` but ACCEPT this knob (verified by spike) — the
      // plan-review turn pins `'xhigh'` so the reviewer reasons hard.
      ...(reasoningEffort ? { modelReasoningEffort: reasoningEffort } : {}),
    };
  }

  private async runCodex(args: RunEngineArgs): Promise<EngineRunResult> {
    const { task, cwd, systemPrompt, sandboxKey, sessionId, mode, onEvent, signal, richStream } =
      args;
    const auth = this.resolveAuth('codex', args.auth);
    // Pass through ONLY an explicit caller override (none today); otherwise leave unset so
    // `codexThreadOptions` omits `model` and the subscription account's default is used (see note above).
    const model = args.model;
    const readOnly = mode !== 'execute';

    const client = this.getCodex(sandboxKey, auth);
    const opts = this.codexThreadOptions(cwd, model, readOnly, args.modelReasoningEffort);
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
                onEvent?.({ kind: 'tool_use', id: item.id, name: 'edit', input: { changes: item.changes } });
                onEvent?.({
                  kind: 'tool_result',
                  id: item.id,
                  result: item.status,
                  isError: item.status === 'failed',
                });
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
