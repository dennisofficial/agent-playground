/**
 * Atlas v2's MINIMAL engine seam — a clean-room rewrite of v1's `worker-engine.port.ts` stripped to
 * exactly what W1 needs: run one Claude/Codex turn in plan or execute mode, threading credentials and
 * an isolated agent home. No roles, no effort knob, no AskUserQuestion relay, no skills/MCP — those
 * v1 concepts are dropped (engines run vanilla). Zero v1 imports.
 */
import type { SessionEngine, SessionMode } from '../domain';

/**
 * How an engine turn authenticates.
 * - 'api_key' (default): bills a metered key per token. Claude reads `ANTHROPIC_API_KEY`; Codex takes
 *   `apiKey`. `apiKey` undefined → fall back to the engine's ambient env (dev convenience).
 * - 'subscription': drive the run off a Claude Max / ChatGPT plan instead. For Claude, `secret` is a
 *   `CLAUDE_CODE_OAUTH_TOKEN`; for Codex it's an `auth.json` blob the overlay home is seeded with.
 */
export type EngineAuth =
  | { mode: 'api_key'; apiKey?: string }
  | { mode: 'subscription'; secret: string };

/** A normalized progress event, emitted by both engines regardless of native event shape. */
export type EngineEvent =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; detail?: string }
  | { kind: 'result'; text: string }
  /**
   * Emitted ONCE as soon as the engine session/thread id is known (turn start) — BEFORE any work. Lets
   * the caller persist the resume handle immediately, so a mid-turn halt (process crash, container/host
   * restart, kill) recovers by CONTINUING this same session instead of spawning a fresh one.
   */
  | { kind: 'session'; sessionId: string };

/** Vendor-neutral token-usage counts (all optional — engines populate what their SDK reports). */
export interface EngineUsage {
  /** Grand-total input INCLUDING cache (fresh + cacheRead + cacheWrite). */
  inputTokens?: number;
  /** Grand-total output INCLUDING reasoning. */
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  /** Exact cost when the SDK provides it (Claude); absent for Codex (priced server-side). */
  costUsd?: number;
  /** The real model id the run used. */
  model?: string;
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
}

export interface RunEngineArgs {
  /** Which engine backs this run. */
  engine: SessionEngine;
  /** The turn's instructions/prompt. */
  task: string;
  /** Working directory the engine is scoped to (the per-feature worktree). */
  cwd: string;
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
  /** Called for each progress event as the run streams. */
  onEvent?: (e: EngineEvent) => void;
  /** Aborts the run when signalled — wired to the SDK's native cancellation. */
  signal?: AbortSignal;
  /**
   * WHERE to execute. Omit → host-local (in-process). When set, the `docker` engine-runner execs the
   * turn inside that sandbox container. The `local` runner ignores it. (Not serialized to the
   * in-container entrypoint — it's a host-side routing hint.)
   */
  target?: ExecutionTarget;
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
 * The ENGINE_RUNNER port — the seam the driver / auto-fix / acceptance-gate consume to run a turn. Two
 * bindings: `EngineRunner` (in-process host-local) and `DockerEngineRunner` (exec inside a sandbox).
 * Selected by `ATLAS_SANDBOX_MODE`. Both honor the same `RunEngineArgs`/`EngineRunResult` contract.
 */
export interface EngineRunnerPort {
  run(args: RunEngineArgs): Promise<EngineRunResult>;
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

/** Heuristic: does this engine error message look like a credential/401 failure (vs a normal error)? */
export function isAuthErrorMessage(message: string): boolean {
  return /\b401\b|not logged in|please run \/login|invalid[ _-]?api[ _-]?key|invalid x-api-key|authentication[ _]?error|\bunauthorized\b|oauth[^.]*\b(expired|invalid|revoked)\b|token[^.]*\b(expired|revoked)\b|permission_error/i.test(
    message,
  );
}
