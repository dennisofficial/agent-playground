/**
 * The HOST ↔ in-sandbox DAEMON wire protocol (Phase 5).
 *
 * DEPENDENCY-FREE on purpose: both the host harness and the trimmed in-container daemon import this
 * file, so it must pull in NOTHING DB-backed, NOTHING Nest-specific, and no engine internals — only
 * the pure shapes that cross the Redis bus and the key-builder helpers. The daemon's tsconfig compiles
 * `../harness/**`, so a stray import here would drag host machinery into the image.
 *
 * Transport overview (all over Redis; the daemon connects OUT to Redis only — NO inbound network):
 *
 *   ws:{workspaceId}:cmds    (Stream, consumer group 'daemon')
 *     The host XADDs commands; the daemon XREADGROUPs + dispatches by `type`.
 *       'run' → reconstitute an engine `run()` call (the daemon's "Claude Code" turn).
 *       'git' → invoke one `DaemonGitService` public method.
 *
 *   run:{correlationId}:events  (Stream)
 *     The daemon XADDs one frame per engine `onEvent`, then a terminal `result` or `error` frame.
 *     The host XREADs (BLOCK) and tails — resumable from the last id after a transient disconnect.
 *
 *   reply:{correlationId}       (Stream)
 *     The daemon writes ONE frame — the typed result of a 'git' RPC (ok/value or error).
 *
 *   run:{correlationId}:abort   (pub/sub)
 *     The host PUBLISHes when the run's AbortSignal fires; the daemon aborts that run's controller.
 */
import { randomUUID } from 'node:crypto';
import type {
  EffortLevel,
  IWorkerUsage,
  WorkerEvent,
  WorkerMode,
  WorkerQuestion,
} from '@harness/engines/worker-engine.port';
import type {
  McpServerConfig,
  SkillSource,
} from '@harness/skills/skill.types';

// NOTE: the two imports above are TYPE-ONLY (`import type`) — they erase at compile time, so this
// file stays runtime-dependency-free (the daemon doesn't pull in the engine/skill modules through it).

// ──────────────────────────────────────────────────────────────────────────────────────────────
// Command stream (host → daemon)
// ──────────────────────────────────────────────────────────────────────────────────────────────

/** The consumer group the daemon reads the command stream under. */
export const DAEMON_CONSUMER_GROUP = 'daemon';

/**
 * The 'run' command payload — `RunWorkerArgs` MINUS the three fields that do NOT cross the wire
 * (`onEvent`/`signal` are functions; `cwd` is the daemon's to resolve from the session's worktree),
 * PLUS the engine name, the host-resolved tool inputs, and the resume id. The daemon reconstitutes the
 * exact `engines.get(engine).run({...})` call from this.
 */
export interface RunCommandPayload {
  /** Which containerized engine runs this turn (langgraph never reaches the daemon). */
  engine: 'claude' | 'codex';
  /** The harness session id — the daemon keys the worktree (the engine cwd) off this. */
  sessionId: string;
  /** The opening/reply message for the turn (RunWorkerArgs.task). */
  task: string;
  /** The composed worker persona for this engine (RunWorkerArgs.systemPrompt). */
  systemPrompt: string;
  /** The owning employee's id — namespaces the per-agent engine home (RunWorkerArgs.agentId). */
  agentId: string;
  /** A prior ENGINE session/thread id to resume, if any (RunWorkerArgs.sessionId). Distinct from the
   * harness `sessionId` above: this is the engine's own resume handle. */
  resumeSessionId?: string;
  /** Override the engine model for this run (RunWorkerArgs.model). */
  model?: string;
  /** Reasoning effort for this run, Claude only (RunWorkerArgs.effort). */
  effort?: EffortLevel;
  /** This turn's mode — REQUIRED, never defaulted (RunWorkerArgs.mode). */
  mode: WorkerMode;
  /** The owning workspace's LLM API key for this run (RunWorkerArgs.apiKey). */
  apiKey?: string;
  /** Host-resolved skill sources for this agent — the daemon `prime`s its home from these (no DB). */
  skillSources: SkillSource[];
  /** Host-resolved MCP servers for this agent. */
  mcpServers: McpServerConfig[];
}

/** The 'git' command payload — a single `DaemonGitService` public method call. */
export interface GitCommandPayload {
  /** The `DaemonGitService` method name (e.g. 'createWorktree', 'publish', 'openPr'). */
  method: string;
  /** Positional args for the method (already JSON-serializable — the git surface takes scalars/objects). */
  args: unknown[];
}

export type DaemonCommandType = 'run' | 'git';

/** A command frame as it sits on `ws:{workspaceId}:cmds` (payload JSON-encoded into one stream field). */
export interface DaemonCommand<T = unknown> {
  type: DaemonCommandType;
  correlationId: string;
  payload: T;
}

export type RunCommand = DaemonCommand<RunCommandPayload> & { type: 'run' };
export type GitCommand = DaemonCommand<GitCommandPayload> & { type: 'git' };

// ──────────────────────────────────────────────────────────────────────────────────────────────
// Event stream (daemon → host) — one per run
// ──────────────────────────────────────────────────────────────────────────────────────────────

/** A streamed engine progress event (maps 1:1 to a `WorkerEvent` passed to the host's `onEvent`). */
export interface RunEventFrame {
  kind: 'event';
  event: WorkerEvent;
}

/** The terminal SUCCESS frame — the engine `run()` return shape, serialized verbatim. */
export interface RunResultFrame {
  kind: 'result';
  result: string;
  sessionId?: string;
  questions?: WorkerQuestion[];
  planText?: string;
  usage?: IWorkerUsage;
}

/** The terminal FAILURE frame — the engine run (or the daemon's reconstitution of it) threw. */
export interface RunErrorFrame {
  kind: 'error';
  message: string;
}

export type RunFrame = RunEventFrame | RunResultFrame | RunErrorFrame;

/** The host-facing return shape of a dispatched run — identical to `WorkerEngine.run()`'s resolve. */
export interface RunResult {
  result: string;
  sessionId?: string;
  questions?: WorkerQuestion[];
  planText?: string;
  usage?: IWorkerUsage;
}

// ──────────────────────────────────────────────────────────────────────────────────────────────
// Reply stream (daemon → host) — one per git RPC
// ──────────────────────────────────────────────────────────────────────────────────────────────

/** The single reply frame for a 'git' command. */
export type GitReplyFrame =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

// ──────────────────────────────────────────────────────────────────────────────────────────────
// Key builders — the ONLY place stream/channel names are constructed (host + daemon agree here).
// ──────────────────────────────────────────────────────────────────────────────────────────────

/** The per-workspace command stream the daemon consumes. */
export const cmdStream = (workspaceId: string): string =>
  `ws:${workspaceId}:cmds`;

/** The per-run event stream the daemon writes and the host tails. */
export const eventStream = (correlationId: string): string =>
  `run:${correlationId}:events`;

/** The per-correlation single-frame reply stream for a git RPC. */
export const replyStream = (correlationId: string): string =>
  `reply:${correlationId}`;

/** The per-run abort pub/sub channel. */
export const abortChannel = (correlationId: string): string =>
  `run:${correlationId}:abort`;

// ──────────────────────────────────────────────────────────────────────────────────────────────
// Correlation id
// ──────────────────────────────────────────────────────────────────────────────────────────────

/** A fresh correlation id namespacing one run's event stream / abort channel (and one git RPC's
 * reply). `randomUUID` is in the Node core `crypto` module — no dependency added. */
export function newCorrelationId(): string {
  return randomUUID();
}
