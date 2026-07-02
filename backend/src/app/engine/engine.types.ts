/**
 * Atlas v2's MINIMAL engine seam — a clean-room rewrite of v1's `worker-engine.port.ts` stripped to
 * exactly what W1 needs: run one Claude/Codex turn in plan or execute mode, threading credentials and
 * an isolated agent home. No roles, no effort knob, no AskUserQuestion relay, no skills/MCP — those
 * v1 concepts are dropped (engines run vanilla). Zero v1 imports.
 */
import type { SessionEngine, SessionMode } from '../domain';

/**
 * How an engine (SDK harness) turn authenticates — ALWAYS a subscription secret. The api_key mode was
 * removed: running the harness on a metered API key is ruinously expensive, so there is no key path
 * and no fallback — a missing secret throws (see `EngineCore.resolveAuth`). For Claude, `secret` is a
 * `CLAUDE_CODE_OAUTH_TOKEN`; for Codex it's an `auth.json` blob the overlay home is seeded with.
 * (The non-agentic LangChain chains keep using `ANTHROPIC_API_KEY` — that path is unrelated.)
 */
export type EngineAuth = { secret: string };

/**
 * One hunk of an Edit/MultiEdit's structured patch (the SDK `tool_use_result.structuredPatch` shape):
 * REAL 1-based file offsets + sign-prefixed lines (`' '` context / `'+'` add / `'-'` del). Carried on
 * `tool_result` so the web diff gutter shows true file line numbers instead of restarting at 1.
 */
export interface StructuredPatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

/** A normalized progress event, emitted by both engines regardless of native event shape. */
export type EngineEvent =
  | { kind: 'text'; text: string; parentToolUseId?: string }
  | { kind: 'tool'; name: string; detail?: string }
  | { kind: 'result'; text: string }
  /**
   * Emitted ONCE as soon as the engine session/thread id is known (turn start) — BEFORE any work. Lets
   * the caller persist the resume handle immediately, so a mid-turn halt (process crash, container/host
   * restart, kill) recovers by CONTINUING this same session instead of spawning a fresh one.
   */
  | { kind: 'session'; sessionId: string }
  /**
   * Emitted when a mid-turn steer (an operator message on `turn:{T}:input`) has been PUSHED into the live
   * SDK session — the durable ACK that the message was actually taken, not just written to the stream. `id`
   * echoes the steer's stimulus id so the host can stamp that message `delivered_at`. Rides the events
   * stream like any other frame, so it survives a host detach + boot re-attach (replayed with the log).
   */
  | { kind: 'input_ack'; id: string }
  // ── Rich streaming (emitted only when `RunEngineArgs.richStream` is set — the thread BRAIN turn). The
  //    `*_delta` kinds are LIVE-only (token-by-token); the full-block kinds (`text`/`thinking`/`tool_use`/
  //    `tool_result`) are AUTHORITATIVE — the caller persists those as the durable transcript. ──
  //
  // `parentToolUseId` (authoritative blocks only): the SDK message's `parent_tool_use_id`. UNSET for the
  // main agent (the brain); SET to the spawning `Task` tool_use id for blocks produced by a SUBAGENT. The
  // caller uses it to peel subagent activity out of the main transcript into its own sub-page.
  /** A live assistant-text token chunk (not persisted; reconciled by the final `text` block).
   *  `parentToolUseId` is SET when the chunk belongs to a SUBAGENT, so live rendering nests it the same
   *  way the authoritative `text` block does. */
  | { kind: 'text_delta'; text: string; parentToolUseId?: string }
  /** A complete thinking block (authoritative — persisted). */
  | { kind: 'thinking'; text: string; parentToolUseId?: string }
  /** A live thinking token chunk (not persisted). `parentToolUseId` SET for subagent chunks. */
  | { kind: 'thinking_delta'; text: string; parentToolUseId?: string }
  /** A tool call with its input (authoritative). Pairs with `tool_result` by `id`. */
  | {
      kind: 'tool_use';
      id: string;
      name: string;
      input?: unknown;
      parentToolUseId?: string;
    }
  /** A tool result (authoritative). `id` correlates to the `tool_use`. */
  | {
      kind: 'tool_result';
      id: string;
      result?: unknown;
      isError?: boolean;
      parentToolUseId?: string;
      /** Edit/MultiEdit only: the SDK's structured patch (real file offsets) for an accurate diff gutter. */
      structuredPatch?: StructuredPatchHunk[];
    };

/** Vendor-neutral token-usage counts (all optional — engines populate what their SDK reports). */
export interface EngineUsage {
  /**
   * Grand-total input INCLUDING cache, SUMMED across every model round-trip in the turn (fresh +
   * cacheRead + cacheWrite). This is the BILLING number — correct for cost ("N in · M cache · $X"),
   * but WRONG as context occupancy: a multi-round-trip turn re-reads the same context from cache each
   * round, so this balloons far past the window. For occupancy use {@link contextTokens}.
   */
  inputTokens?: number;
  /** Grand-total output INCLUDING reasoning. */
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  /** Exact cost when the SDK provides it (Claude); absent for Codex (priced server-side). */
  costUsd?: number;
  /** The real model id the run used (for billing — sourced from the cumulative usage, may be a helper). */
  model?: string;
  /**
   * The CONTEXT-WINDOW OCCUPANCY proxy: the input-token size of a SINGLE model round-trip (fresh +
   * cacheRead + cacheWrite for that one call), NOT the cumulative {@link inputTokens} sum. This is how
   * full the context window actually is — render the occupancy ring against this. Tracked from the
   * MAIN agent's last round-trip only (subagents run in their own context on cheaper models). Absent
   * when the engine doesn't surface per-call usage (e.g. Codex).
   */
  contextTokens?: number;
  /**
   * The model id of the round-trip {@link contextTokens} came from — the MAIN agent's real model, so
   * the occupancy ring resolves the right window even when {@link model} reflects a helper. Absent
   * when no per-call model was seen.
   */
  contextModel?: string;
}

/**
 * Per-model context-window size (max input tokens), keyed by a substring of the real model id the turn
 * reported in {@link EngineUsage.model}. The web renders a context-occupancy ring against this, so it
 * threads whatever model the brain runs — never hardcoded on the client.
 *
 * Current official windows (Anthropic docs): Opus 4.x and Sonnet 4.x are 1M, Haiku is 200k. The
 * authoritative long-term source is the Models API `max_input_tokens`; this static map is the v1 proxy
 * and is the single place to edit if a window changes. Order matters — first matching substring wins.
 */
const MODEL_CONTEXT_LIMITS: ReadonlyArray<readonly [match: string, limit: number]> = [
  ['opus', 1_000_000],
  ['sonnet', 1_000_000],
  ['haiku', 200_000],
];

/** Fallback window when the model id is unknown/absent — the conservative 200k floor. */
export const DEFAULT_CONTEXT_LIMIT = 200_000;

/** Resolve a model's context-window size (max input tokens) from its reported id. */
export function resolveContextLimit(model?: string): number {
  const id = (model ?? '').toLowerCase();
  for (const [match, limit] of MODEL_CONTEXT_LIMITS) {
    if (id.includes(match)) return limit;
  }
  return DEFAULT_CONTEXT_LIMIT;
}

/**
 * WHERE a turn executes. Absent (the default) → run in-process on the host (the `local` runner). When
 * present, the `docker` runner `docker exec`s the engine entrypoint inside `containerId` as `user`.
 * Passed explicitly through the port so the runner never has to derive a container from a string.
 */
export interface ExecutionTarget {
  /** The sandbox container to exec the turn inside. */
  containerId: string;
  /** Run the exec as this user (uid or uid:gid) — host-uid so worktree files stay host-owned. */
  user?: string;
  /**
   * The HOST worktree root for this turn. The worktree is bind-mounted at a NEUTRAL container path
   * (`/workspace`, not same-path), so the runner rewrites `cwd` from this host root onto that mount. Absent
   * → the runner assumes the turn runs at the worktree root.
   */
  worktreeHost?: string;
  /**
   * Authenticated-git for this turn: the agent inside the sandbox can `fetch`/`push`/merge against the
   * remote. Sourced from the RESOLVED repo (repo url + org PAT via `CredentialResolver`), NOT from the
   * sandbox (a row-sourced `FeatureSandbox` has an empty `gitUrl`/no token). Set only on the two turn
   * types that mutate git — brain operator turns and build/execute turns. The runner turns this into the
   * `GIT_CONFIG_*` extraheader + `GITHUB_TOKEN` in the turn's exec env; the token never lands in argv or
   * `.git/config`. Absent → git remote ops fail closed (`GIT_TERMINAL_PROMPT=0`).
   */
  gitAuth?: { gitUrl: string; token?: string };
}

// ── Tool-bridge frame protocol ────────────────────────────────────────────────────────────────────
//
// R1: a bidirectional frame protocol over the exec channel (docker exec OR local subprocess stdio).
// The in-container side emits tool_request on stdout; the host answers on stdin with tool_response
// or tool_error, correlated by id. This is additive — only active when `toolBridge` is set on
// RunEngineArgs; existing one-shot build turns are unaffected.

/**
 * A tool invocation emitted by the in-container entrypoint on stdout.
 * Correlated to a response by `id` (a UUID the in-container side generates).
 */
export interface ToolRequestFrame {
  t: 'tool_request';
  /** UUID generated by the in-container side — the correlation key. */
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/**
 * The host's successful answer to a {@link ToolRequestFrame} — written to stdin.
 */
export interface ToolResponseFrame {
  t: 'tool_response';
  /** Matches the originating `tool_request.id`. */
  id: string;
  result: unknown;
}

/**
 * The host's error answer to a {@link ToolRequestFrame} — written to stdin.
 */
export interface ToolErrorFrame {
  t: 'tool_error';
  /** Matches the originating `tool_request.id`. */
  id: string;
  message: string;
}

/** Union of frames the host may write to the exec's stdin (one per line). */
export type HostFrame = ToolResponseFrame | ToolErrorFrame;

/** A host-side tool implementation. Receives parsed args, returns a serializable result. */
export type ToolImpl = (args: Record<string, unknown>) => Promise<unknown>;

/**
 * Options to activate the bidirectional tool bridge for a turn.
 * The in-container entrypoint will host a thin MCP server whose tools proxy back to the host via
 * the frame protocol; the host dispatches each `tool_request` using `tools`.
 */
export interface ToolBridgeOptions {
  /**
   * The thread that owns this exec. Used to enforce per-thread scoping: any `tool_request` that
   * names a resource scoped to a different thread is denied.
   */
  jobId: string;
  /**
   * Host-side tool dispatch table. Keys are tool names; values are the implementations that execute
   * on the host. The dispatch layer enforces `jobId` scoping before calling these.
   */
  tools: Record<string, ToolImpl>;
}

/**
 * Prepended to a RESUMED turn's task when its sandbox container was just re-attached COLD (reaped while
 * idle, or recovered after a crash/host-restart). The resumed engine session remembers state from prior
 * turns that no longer exists in the fresh container — this tells it the truth so it re-establishes its
 * runtime instead of trusting stale beliefs. (Standing "verify before assuming" guidance lives in the
 * personas; this is the one-time per-reset signal, kept OUT of the byte-stable system prompt.)
 */
export const SANDBOX_RESET_NOTICE = [
  '[sandbox reset] Your sandbox was restarted since your last turn. Any background processes you started',
  'earlier (dev servers, test watchers, headless browsers, docker compose services) are NO LONGER RUNNING',
  'and in-memory state is gone — but files you committed to the worktree are intact. Run `atlas-svc ps` to',
  'see which supervised services are now `stopped`, and restart the ones you need with `atlas-svc run`.',
  'Before relying on any server, verify it is actually up (curl/health-check). Do not assume anything you',
  'started in a previous turn is still alive.',
].join(' ');

/**
 * Codex reasoning effort — mirrors `@openai/codex-sdk`'s `ModelReasoningEffort` (v0.137.0). Kept as a
 * local union so `engine.types.ts` stays SDK-import-free (the SDK is loaded dynamically in-container).
 */
export type CodexReasoningEffort =
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh';

export interface RunEngineArgs {
  /** Which engine backs this run. */
  engine: SessionEngine;
  /** The turn's instructions/prompt. */
  task: string;
  /** Working directory the engine is scoped to (the per-feature worktree). */
  cwd: string;
  /**
   * Extra absolute roots (beyond `cwd`) that Write/Edit may target on an execute turn. Already
   * resolved to the engine's filesystem view (container paths in-sandbox) — NOT host paths to rebase.
   * The docker runner sets this to the durable `/context` shared mount so the brain can author the
   * plan/spec there (it lives OUTSIDE the worktree, so the worktree-only boundary would otherwise
   * force a Bash fallback). Empty/omitted → writes are confined to `cwd`.
   */
  writableRoots?: string[];
  /** The system prompt / persona for this turn (Codex seeds it as a first-turn preamble). */
  systemPrompt: string;
  /**
   * Stable per-feature key that namespaces the engine's isolated CLAUDE_CONFIG_DIR / CODEX_HOME, so
   * two concurrent features never share engine state. Use the feature/sandbox key.
   */
  sandboxKey: string;
  /** A prior engine session/thread id to resume, if any. */
  sessionId?: string;
  /**
   * This turn's mode. REQUIRED (no default): a missing mode must never silently grant writes. 'plan'
   * and 'review' are read-only at the engine seam ('plan' adds Claude's native plan ceremony; 'review'
   * is read-only without it). Only 'execute' may write.
   */
  mode: SessionMode;
  /** How this run authenticates. Unset → the engine falls back to its ambient env. */
  auth?: EngineAuth;
  /** Override the model for this run. Falls back to the engine's env/default when unset. */
  model?: string;
  /**
   * Codex-only: the reasoning effort for this run (maps to the SDK's `ThreadOptions.modelReasoningEffort`).
   * Unset → the account/CLI default. The plan-review turn pins `'xhigh'` so the reviewer reasons hard.
   * (A ChatGPT-account token REJECTS an explicit `model`, but ACCEPTS this knob — verified by spike.)
   */
  modelReasoningEffort?: CodexReasoningEffort;
  /** Called for each progress event as the run streams. */
  onEvent?: (e: EngineEvent) => void;
  /**
   * Opt into RICH token-level streaming (the thread brain): enables the SDK's partial-message stream +
   * extended thinking, so `runClaude` emits `text_delta`/`thinking`/`thinking_delta`/`tool_use`/
   * `tool_result` events in addition to the coarse `text`/`tool`/`result`. Omit (build/step turns) for
   * the existing block-level behavior.
   */
  richStream?: boolean;
  /** Aborts the run when signalled — wired to the SDK's native cancellation. */
  signal?: AbortSignal;
  /**
   * Opt into MID-TURN STEERING (the operator-facing brain turn): the in-container entrypoint runs the SDK
   * in STREAMING-INPUT mode and subscribes to `turn:{T}:input`, so an operator message can be injected into
   * the RUNNING turn (`priority:'now'`) and the model reacts before the turn ends — instead of queuing until
   * the next turn. Serialized into the turn spec. Omit (build/plan/review workers) for the single-message path.
   */
  steerable?: boolean;
  /**
   * The live source of mid-turn steering messages, drained into the SDK's streaming input with
   * `priority:'now'`. NOT serialized — the in-container entrypoint builds it from the `turn:{T}:input`
   * Redis channel (gated on `steerable`) and passes it in-process to the engine core. When present the
   * engine runs in streaming-input mode; when absent it uses the single-message prompt. Each item carries
   * the steer's stimulus `id` (when present) so the core can emit a correlated `input_ack` after pushing it.
   */
  steerInput?: AsyncIterable<{ id?: string; text: string }>;
  /**
   * Fired ONCE, host-side, the instant this turn is DURABLY registered + kicked (its `active_turns` row is
   * committed and the engine is running detached) — i.e. the moment the turn becomes restart-survivable via
   * boot re-attach. The brain uses this to stamp an operator message `delivered_at` at hand-off (not at
   * completion), so a mid-turn crash leaves it delivered-and-resumable rather than lost or double-run. Only
   * the Redis runner fires it (the only restart-survivable transport). Best-effort; never blocks the turn.
   */
  onTurnRegistered?(turnId: string): void;
  /**
   * WHERE to execute. Omit → host-local (in-process). When set, the `docker` engine-runner execs the
   * turn inside that sandbox container. The `local` runner ignores it. (Not serialized to the
   * in-container entrypoint — it's a host-side routing hint.)
   */
  target?: ExecutionTarget;
  /**
   * Activate the bidirectional tool bridge for this turn. When set, the exec's stdin stays open and
   * the host dispatches `tool_request` frames from the in-container side back to the host tools,
   * returning correlated `tool_response`/`tool_error` frames. Additive — omit for the existing
   * one-shot build turns (backward-compatible).
   */
  toolBridge?: ToolBridgeOptions;
  /**
   * Optional registry context for a RESTART-SURVIVABLE Redis-transport turn. When set (and
   * `ENGINE_TRANSPORT=redis`), the runner records an `active_turns` row so a fresh backend can
   * re-attach to this turn after a restart. Ignored by the pipe runner. See ADR 0001.
   */
  turnMeta?: TurnMeta;
}

/** Registry context carried on a Redis-transport turn (rebuilds the harness + brain tool closure on re-attach). */
export interface TurnMeta {
  jobId: string;
  orgId: string;
  /** SSE fan-out channel (repo id). */
  channel: string;
  /** Transcript lane: 'main' (brain) | 'thread:<threadId>' (a build thread) | 'codex-review:<jobId>'. */
  lane: string;
  kind: 'brain' | 'step' | 'review' | 'gate' | 'autofix';
  /** Per-kind params needed to rebuild the turn on re-attach (author, prompt, route, timeouts, …). */
  ctx?: Record<string, unknown>;
}

/** The result of one engine run — the report, the resume handle, and optional plan/usage. */
export interface EngineRunResult {
  result: string;
  sessionId?: string;
  /** The captured plan text on a Claude 'plan' turn (the substance is the plan, not the summary). */
  planText?: string;
  usage?: EngineUsage;
}

/**
 * The ENGINE_RUNNER port — the seam the driver / auto-fix / acceptance-gate consume to run a turn.
 * Always bound to `DockerEngineRunner` (exec inside a sandbox container). Docker is the only execution
 * mode; the former in-process `EngineRunner` has been removed.
 */
export interface EngineRunnerPort {
  run(args: RunEngineArgs): Promise<EngineRunResult>;
  /**
   * RE-ATTACH to an in-flight turn after a backend restart — resume tailing its durable Redis streams +
   * serving its tool bridge WITHOUT re-kicking the engine (the detached engine kept running). Only the
   * Redis runner implements it (the pipe runner has no restart-survivable turns); optional on the port.
   */
  reattach?(
    turnId: string,
    containerId: string,
    args: {
      onEvent?: (e: EngineEvent) => void;
      toolBridge?: ToolBridgeOptions;
      signal?: AbortSignal;
    },
  ): Promise<EngineRunResult>;
  /**
   * True while THIS process has a live attach loop tailing `turnId`. Guards the promotion re-attach
   * sweep from double-attaching a turn this same process kicked (a mid-day leader flap re-fires
   * `onPromote` while turns are in flight). Only the Redis runner implements it.
   */
  isAttached?(turnId: string): boolean;
  /**
   * STEER a running (`steerable`) turn: publish an operator message to `turn:{T}:input`, which the
   * in-container entrypoint injects into the live SDK session with `priority:'now'` (mid-turn steering).
   * The `id` (the steer's stimulus id) rides the frame so the engine can emit a correlated `input_ack`
   * once it PUSHES the message into the session — the durable proof it was taken (the caller stamps
   * `delivered_at` only on that ack, never on the write). No-op transport-wise if the turn already ended
   * (the engine has closed its input stream) — no ack ever comes, and the caller re-drives. Only the Redis
   * runner implements it.
   */
  steer?(turnId: string, id: string, text: string): Promise<void>;
  /**
   * STOP a running turn: publish a cooperative abort to `turn:{T}:abort`. The in-container entrypoint
   * aborts the SDK query; the engine writes a graceful `final` (the partial transcript is preserved) and
   * the normal completion path finalizes the registry row, reclaims the streams, and clears `turn_active`.
   * Only the Redis runner implements it.
   */
  stop?(turnId: string): Promise<void>;
}

/** DI token for {@link EngineRunnerPort}. */
export const ENGINE_RUNNER = Symbol('ENGINE_RUNNER');

/**
 * A CREDENTIAL/auth failure during a turn (a 401 / expired token / "not logged in"), distinguished
 * from a normal turn error so the driver can PAUSE (and later resume the SAME engine session on a ping)
 * instead of failing the job from scratch. Carries the engine `sessionId` when one was established
 * before the failure — the resume handle that lets a re-ping continue where the agent left off (its
 * partial work is already on disk in the worktree + remembered in the session transcript).
 */
export class EngineAuthError extends Error {
  /** Discriminator that survives a structuredClone / cross-process reconstruction. */
  readonly isAuthError = true;
  constructor(
    message: string,
    /** The engine session to resume on a re-ping (undefined if the 401 hit before a session started). */
    readonly sessionId?: string,
  ) {
    super(message);
    this.name = 'EngineAuthError';
  }
}

/**
 * The host LOST ITS TRANSPORT to a still-running turn — the Redis tail failed mid-turn (typically the
 * process's own shutdown closing the client during a watch respawn), NOT the engine concluding. The
 * detached engine keeps running and keeps writing its durable streams, so the correct reaction everywhere
 * is to WALK AWAY: leave the `active_turns` row and the streams for the next boot's re-attach, persist
 * nothing (the re-attach replays the log from the start — a partial persist here would double it), and
 * post no operator-facing failure (the turn didn't fail). See ADR 0001.
 */
export class EngineDetachedError extends Error {
  /** Discriminator that survives error re-wrapping across module seams. */
  readonly isDetachedError = true;
  constructor(message: string) {
    super(message);
    this.name = 'EngineDetachedError';
  }
}

/** Whether this error is the host losing its tail mid-turn (see {@link EngineDetachedError}). */
export function isEngineDetachedError(err: unknown): boolean {
  return err instanceof EngineDetachedError || (err as { isDetachedError?: boolean })?.isDetachedError === true;
}

/**
 * A marker embedded in the thrown error when a stored engine session can't be resumed — its transcript
 * is missing from the config dir (e.g. the agent-home dir name changed, or the home was cleared). Unlike
 * a normal turn error, RETRYING is futile: the session state is gone for good and the thread must be
 * recreated. The marker is plain text so it survives the in-container → host error-frame boundary; the
 * host matches it via {@link isUnresumableSessionMessage} to show a specific, actionable message.
 */
export const UNRESUMABLE_SESSION_MARKER = 'ENGINE_SESSION_UNRESUMABLE';

/** Whether this engine error is an unresumable-session failure (see {@link UNRESUMABLE_SESSION_MARKER}). */
export function isUnresumableSessionMessage(message: string): boolean {
  return message.includes(UNRESUMABLE_SESSION_MARKER);
}

/** Heuristic: does this engine error message look like a credential/401 failure (vs a normal error)? */
export function isAuthErrorMessage(message: string): boolean {
  return /\b401\b|not logged in|please run \/login|invalid[ _-]?api[ _-]?key|invalid x-api-key|authentication[ _]?error|\bunauthorized\b|oauth[^.]*\b(expired|invalid|revoked)\b|token[^.]*\b(expired|revoked)\b|permission_error/i.test(
    message,
  );
}
