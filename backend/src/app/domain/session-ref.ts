/**
 * A handle to a running engine session — the brain's reference to a "hands" turn. Phases run as
 * sequential FRESH sessions on the feature branch; a `SessionRef` is the in-memory pointer the driver
 * holds while a step builds (the engine conversation id + the sandbox/worktree it runs in). W1 owns
 * the local turn-runner that actually drives these; W0 just defines the shape so the driver/domain
 * types can reference it.
 */

/** The engine backing the session. */
export type SessionEngine = 'claude' | 'codex';

/**
 * How a turn runs — read-only vs. writes. 'plan'/'review'/'investigate' are read-only (no commits);
 * 'execute' writes. 'investigate' is the STRICTEST read-only posture — Read/Glob/Grep only, NO Bash —
 * used for scoping/grilling over a shared clone where even a read-only Bash could mutate. Mirrors the
 * proven per-turn mode model without carrying v1's session machinery.
 */
export type SessionMode = 'plan' | 'execute' | 'review' | 'investigate';

/** A reference to one engine session running inside a per-feature sandbox (MVP: a local worktree). */
export interface SessionRef {
  /** Stable session id (the engine conversation handle). */
  id: string;
  /** The thread this session serves. */
  threadId: string;
  /** The step this session is building (null for non-step sessions, e.g. planning). */
  stepId: string | null;
  engine: SessionEngine;
  mode: SessionMode;
  /** The feature branch the session works on (shared across the job's steps). */
  branch: string;
  /** Absolute path to the sandbox checkout (MVP: a local git worktree). */
  worktreePath: string;
}
