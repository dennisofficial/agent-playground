import {
  EWorkerEngineName,
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
  /** The tenant (Slack team id) — resolves the engine's LLM key and scopes the worklog. */
  team: string;
  /** The project/workspace this work belongs to — scopes the work log (isolation). */
  project: string;
  /** Which worker engine runs this session (claude / codex / langgraph). */
  engine: EWorkerEngineName;
  /** The mode of the LATEST turn — per-turn switchable (approving a plan = replying with 'execute'). */
  mode: WorkerMode;
  /** The engine's own session/thread id, recorded once the worker reports it (the resume handle). */
  engineSessionId?: string;
  /** How many turns have completed. */
  turns: number;
  /** The latest turn's report — what relayed back to the owner. */
  lastReport?: string;
  /** What kind of report the last turn produced: 'questions' = the turn ended by asking (the owner
   * answers via reply_session), 'plan' = a captured plan (with its Q&A appendix when any exists),
   * undefined = ordinary prose. Set on EVERY turn-end so a stale kind never survives. */
  lastReportKind?: 'plan' | 'questions';
  /** Planning Q&A ledger: each asking-turn's report paired with the owner's answer, in order —
   * appended to the finished plan so every planning decision is visible at approval. */
  qa?: { q: string; a: string }[];
  /** The team-board task this session works, when linked. The approval guard's anchor: an execute
   * turn on a linked session is refused until the task is 'approved'. */
  boardTaskId?: number;
  /** Reference projects/repos attached to this session for READ-ONLY grounding — each carries the
   * on-disk clone `path` the engine reads (advisory in dev where the engine already reads any host
   * path; the container-mount seam in v2, where these paths become read-only mounts). `mode` is
   * 'read' in v1; the shape leaves room for a future 'write' (cross-repo) upgrade without a migration.
   * The session's full read set is `[worktree.path, ...referencedProjects.map(r => r.path)]`. */
  referencedProjects?: Array<{
    projectId?: string;
    gitUrl: string;
    path: string;
    mode: 'read';
  }>;
  /** Whether the last turn's finished plan was durably attached to the linked board task (set on
   * plan-kind turn-ends of linked sessions; false = the attach FAILED and the owner should park
   * the plan on the ticket via add_note). Cleared on every other turn-end like lastReportKind. */
  planAttached?: boolean;
  error?: string;
}

export interface NewSession {
  task: string;
  worktreeId: string;
  notifyThread: string;
  engine: EWorkerEngineName;
  ownerBot: string;
  team: string;
  project: string;
  // REQUIRED (no default): a missing mode must never silently create a write-capable session.
  mode: WorkerMode;
  /** Link to the team-board task this session works (see Session.boardTaskId). */
  boardTaskId?: number;
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
