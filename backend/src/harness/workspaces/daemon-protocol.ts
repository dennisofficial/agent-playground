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
 *
 *   ws:{workspaceId}:cred-req / cred-reply:{nonce}   (pub/sub, NON-persisted, bootstrap-token-authed)
 *     The just-in-time credential pull (Phase 6). The daemon PUBLISHes a `{nonce, bootstrapToken}`
 *     request on its workspace's cred-req channel; the host validates the bootstrap token against the
 *     one it issued for that workspace, resolves the GitHub credential, and PUBLISHes the reply on the
 *     per-nonce reply channel. Pub/sub (not a stream) on purpose: a credential must NEVER persist on the
 *     bus — it lives only for the round-trip. The token never appears in logs.
 */
import { randomUUID } from 'node:crypto';
import type {
  EffortLevel,
  EngineAuth,
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
  /** The WORK AREA this turn runs in — the daemon keys the worktree (the engine cwd) off this, so all
   * sessions in a work area share one checkout (a review session sees the build session's tree). */
  workAreaId: string;
  /** The harness session id — DISTINCT from the work area (a work area hosts several sessions). Used for
   * the deterministic per-session dev-server PORT + tracing, NOT as the worktree key. */
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
  /** How this run authenticates (RunWorkerArgs.engineAuth) — the API key OR the workspace's
   * subscription secret. Crosses the bus only for this round-trip (never persisted/logged), same as
   * the API key did before: the daemon has no DB/cipher, so the host-decrypted secret must travel. */
  engineAuth?: EngineAuth;
  /** The owning workspace (Slack team) id (RunWorkerArgs.team) — keys the codex subscription home. */
  team?: string;
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
// Credential-pull channel (daemon → host → daemon) — the just-in-time git-credential round-trip
// ──────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The credential REQUEST the daemon publishes on `ws:{workspaceId}:cred-req`. The host authenticates it
 * by comparing `bootstrapToken` against the short random token it issued for this workspace at container
 * creation (and tracks in `SandboxRegistry`). The `nonce` namespaces the matching reply channel.
 */
export interface CredentialRequest {
  /** A fresh per-request id — the reply lands on `cred-reply:{nonce}`. */
  nonce: string;
  /** The `DAEMON_BOOTSTRAP_TOKEN` the daemon was started with — proves it's THIS workspace's daemon. */
  bootstrapToken: string;
}

/**
 * The resolved git credential the host sends back. PROVIDER-NEUTRAL: `kind:'pat'` today (the
 * `GithubTokenStore`-resolved PAT + the PAT owner / bot author identity); a future `kind:'github-app'`
 * can carry a minted installation token under the SAME envelope without changing the wire contract.
 */
export interface GitCredentialPayload {
  kind: 'pat';
  /** The GitHub token — rides in `GIT_CONFIG_*` via `gitAuthEnv`, never logged. */
  token: string;
  /** The git author name set on the in-sandbox per-session worktree config. */
  authorName: string;
  /** The git author email set on the in-sandbox per-session worktree config. */
  authorEmail: string;
}

/** The credential REPLY frame on `cred-reply:{nonce}` — the credential, or a reason it couldn't issue. */
export type CredentialReply =
  | { ok: true; credential: GitCredentialPayload }
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

/** The per-workspace credential-REQUEST pub/sub channel (daemon publishes, host subscribes). */
export const credRequestChannel = (workspaceId: string): string =>
  `ws:${workspaceId}:cred-req`;

/**
 * The per-workspace READINESS stream (daemon → host). The daemon XADDs a single `ReadyFrame` once the
 * sandbox is fully up — engines resolvable AND (when inner Docker is expected) `docker info` succeeds —
 * so the host never dispatches a turn that needs `docker compose` before the inner engine is reachable.
 * A stream (not a transient pub/sub) on purpose: it's durable, so a host that connects/queries AFTER
 * the daemon became ready still sees the marker (the credential round-trip's timing problem doesn't
 * apply here).
 */
export const readyKey = (workspaceId: string): string =>
  `ws:${workspaceId}:ready`;

/** The readiness marker frame the daemon writes once the sandbox is fully up. */
export interface ReadyFrame {
  ready: true;
  /** Whether the inner Docker daemon was confirmed reachable (`docker info` ok) before signaling. */
  innerDocker: boolean;
  /** Daemon-clock ms when readiness was signaled (diagnostics only). */
  at: number;
}

/** The per-nonce credential-REPLY pub/sub channel (host publishes, daemon subscribes). */
export const credReplyChannel = (nonce: string): string =>
  `cred-reply:${nonce}`;

// ──────────────────────────────────────────────────────────────────────────────────────────────
// Correlation id
// ──────────────────────────────────────────────────────────────────────────────────────────────

/** A fresh correlation id namespacing one run's event stream / abort channel (and one git RPC's
 * reply). `randomUUID` is in the Node core `crypto` module — no dependency added. */
export function newCorrelationId(): string {
  return randomUUID();
}
