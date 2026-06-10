import type {
  WorkerEngineName,
  WorkerEvent,
  WorkerMode,
} from '../engines/worker-engine.port';

/** DI token for the session registry — the ledger of the employees' open background sessions. */
export const SESSION_REGISTRY = Symbol('SESSION_REGISTRY');

// 'running' = a turn is in flight; 'idle' = the last turn reported back and the session is OPEN,
// waiting for its owner to reply into it, relay, or close it; 'failed' = the last turn errored but
// the session is still open (a reply retries on the same engine session); 'closed' = the owner
// closed it (the only terminal state — closing mid-turn aborts the run and discards its result).
export type SessionStatus = 'running' | 'idle' | 'closed' | 'failed';

/**
 * A session is a long-lived, interactive engine conversation — the employee's background
 * Claude Code-style worker. The employee creates it against a worktree, talks to it across turns
 * (each turn runs to a report and relays back), and explicitly closes it when that thread of work
 * is done. Unlike the old one-shot jobs, every turn-end leaves the session OPEN with full context.
 */
export interface Session {
  id: string;
  /** The opening task — titles list_sessions and the worklog entry written on close. */
  task: string;
  /** The worktree this session runs in. REQUIRED — every session lives in an isolated work area. */
  worktreeId: string;
  status: SessionStatus;
  /** The chat surface/thread the session was opened from. Used for memory-identity scoping on the
   * relay turn; it does NOT route delivery yet — relays post to the process's single channel until
   * the multi-surface (Slack) pass gives the conductor something to route to. */
  notifyThread: string;
  /** Which bot owns this session — scopes the session tools and routes turn-end relays to it. */
  ownerBot: string;
  /** The project/workspace this work belongs to — scopes the work log (isolation). */
  project: string;
  /** Which worker engine runs this session (claude / codex / langgraph). */
  engine: WorkerEngineName;
  /** The mode of the LATEST turn — per-turn switchable (approving a plan = replying with 'execute'). */
  mode: WorkerMode;
  /** The engine's own session/thread id, recorded once the worker reports it (the resume handle). */
  engineSessionId?: string;
  /** How many turns have completed. */
  turns: number;
  /** The latest turn's report — what relayed back to the owner. */
  lastReport?: string;
  error?: string;
}

export interface NewSession {
  task: string;
  worktreeId: string;
  notifyThread: string;
  engine: WorkerEngineName;
  ownerBot: string;
  project: string;
  // REQUIRED (no default): a missing mode must never silently create a write-capable session.
  mode: WorkerMode;
}

/**
 * The session-registry port. The in-memory impl (`InMemorySessionRegistry`) is the v0; every method
 * is async anyway so a Postgres-backed impl can swap in behind this token without touching callers.
 * v0 limits: sessions vanish on restart (their worktrees survive and are re-adopted); `onUpdate`
 * only fires within this process.
 */
export interface SessionRegistry {
  create(input: NewSession): Promise<Session>;
  get(id: string): Promise<Session | undefined>;
  list(filter?: {
    ownerBot?: string;
    status?: SessionStatus;
    worktreeId?: string;
  }): Promise<Session[]>;
  /** Most recently created session (optionally scoped to one owner) — used when a tool gets no id. */
  latest(ownerBot?: string): Promise<Session | undefined>;
  update(
    id: string,
    patch: Partial<Omit<Session, 'id'>>,
  ): Promise<Session | undefined>;
  /** Append a streamed worker event to the session's transcript (what check/search read). */
  appendProgress(id: string, event: WorkerEvent): Promise<void>;
  /** Read a session's accumulated transcript events (oldest first, across all its turns). */
  progress(id: string): Promise<WorkerEvent[]>;
  /** Subscribe to session lifecycle changes. Returns an unsubscribe function. */
  onUpdate(cb: (session: Session) => void): () => void;
}
