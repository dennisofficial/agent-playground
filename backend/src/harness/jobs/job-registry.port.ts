import type { WorkerEngineName, WorkerEvent } from '../engines/worker-engine.port';

/** DI token for the job registry — the ledger of background engine sessions. */
export const JOB_REGISTRY = Symbol('JOB_REGISTRY');

// 'awaiting' = a background turn finished and is waiting for the chat-self to decide what's next.
// 'cancelled' = the owner aborted it mid-run (or while awaiting); its result is discarded, not relayed.
export type JobStatus = 'running' | 'awaiting' | 'done' | 'failed' | 'cancelled';

// 'plan' = produce + confirm a plan before executing; 'execute' = run straight to completion.
// This migration pass only ever creates 'plan' (read-only) jobs — the human-approval path that mints
// 'execute' jobs (plan→approve→execute) is deliberately NOT ported yet, so the "AI never authorizes
// its own writes" invariant holds structurally.
export type WorkerMode = 'plan' | 'execute';

export interface Job {
  id: string;
  task: string;
  status: JobStatus;
  /** The job's own background thread id (`job:{id}`). */
  threadId: string;
  /** Chat thread that should receive the completion relay (the surface it was dispatched from). */
  notifyThread: string;
  /** Which bot owns this job — scopes the job tools and routes the completion relay to that bot. */
  ownerBot: string;
  /** The project/workspace this work belongs to — scopes the work log (isolation). */
  project: string;
  /** Which worker engine runs this job (claude / codex / langgraph). */
  engine: WorkerEngineName;
  /** Whether this job plans-then-confirms before executing, or runs straight through. */
  mode: WorkerMode;
  /** The engine's session/thread id, recorded once the worker reports it (resume across turns). */
  sessionId?: string;
  /** How many background turns have run — drives the runaway cap. */
  turns: number;
  /** How many times this job has been resumed via continue_work — starts at 0, debugging aid. */
  version: number;
  /** The latest turn's report to the chat-self (its final text, including the STATUS line). */
  lastReport?: string;
  result?: string;
  error?: string;
}

export interface NewJob {
  task: string;
  notifyThread: string;
  engine: WorkerEngineName;
  ownerBot: string;
  project: string;
  // REQUIRED (no default): a missing mode must never silently create a write-capable 'execute' job.
  mode: WorkerMode;
}

/**
 * The job-registry port. The in-memory impl (`InMemoryJobRegistry`) is the v0; every method is async
 * anyway so a Postgres- or BullMQ-backed impl can swap in behind this token without touching callers.
 * v0 limits: jobs vanish on restart; `onUpdate` only fires within this process.
 */
export interface JobRegistry {
  create(input: NewJob): Promise<Job>;
  get(id: string): Promise<Job | undefined>;
  list(filter?: { ownerBot?: string; status?: JobStatus }): Promise<Job[]>;
  /** Most recently created job (optionally scoped to one owner bot) — used when check_job has no id. */
  latest(ownerBot?: string): Promise<Job | undefined>;
  update(id: string, patch: Partial<Omit<Job, 'id'>>): Promise<Job | undefined>;
  /** Append a streamed worker event to a job's progress buffer (the source for check_job reads). */
  appendProgress(id: string, event: WorkerEvent): Promise<void>;
  /** Read a job's accumulated progress events (oldest first). */
  progress(id: string): Promise<WorkerEvent[]>;
  /** Subscribe to job lifecycle changes. Returns an unsubscribe function. */
  onUpdate(cb: (job: Job) => void): () => void;
}
