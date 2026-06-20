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
  | { kind: 'result'; text: string };

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
}

/** The result of one engine run — the report, the resume handle, and optional plan/usage. */
export interface EngineRunResult {
  result: string;
  sessionId?: string;
  /** The captured plan text on a Claude 'plan' turn (the substance is the plan, not the summary). */
  planText?: string;
  usage?: EngineUsage;
}
