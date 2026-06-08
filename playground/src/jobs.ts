import { EventEmitter } from 'node:events';
import type { WorkerEngineName, WorkerEvent } from './engines/types.js';

/** The single chat surface in v0. Jobs record which chat thread should receive their relay. */
export const CLI_THREAD_ID = 'zero:cli:main';

// 'awaiting' = a background turn finished and is waiting for the chat-self to decide what's next.
// 'cancelled' = the owner aborted it mid-run (or while awaiting); its result is discarded, not relayed.
export type JobStatus = 'running' | 'awaiting' | 'done' | 'failed' | 'cancelled';

export interface Job {
  id: string;
  task: string;
  status: JobStatus;
  threadId: string;
  /** Chat thread that should receive the completion relay (the surface it was dispatched from). */
  notifyThread: string;
  /** Which bot owns this job — scopes the job tools and routes the completion relay to that bot. */
  ownerBot: string;
  /** The project/workspace this work belongs to — scopes the work log (multi-project isolation). */
  company: string;
  /** Which worker engine runs this job (claude / codex / langgraph). */
  engine: WorkerEngineName;
  /** The engine's session/thread id, recorded once the worker reports it (resume across turns). */
  sessionId?: string;
  /** How many background turns have run — drives the runaway cap. */
  turns: number;
  /** The latest turn's report to the chat-self (its final text, including the STATUS line). */
  lastReport?: string;
  result?: string;
  error?: string;
}

/**
 * v0 in-process job registry — the connective tissue between the chat layer and the worker.
 *
 * DEVIATION from ARCHITECTURE.md (which specifies a SQLite registry): this is an in-memory
 * Map. Limits to accept for v0:
 *   - Jobs vanish on CLI restart (no persistence).
 *   - onJobUpdate notifications only fire within THIS process (the emitter is in-memory).
 *   - No separate/multi-process runner can observe these jobs.
 * The function surface below is the swap point for the v1 SQLite upgrade.
 */
const jobs = new Map<string, Job>();
const emitter = new EventEmitter();

// Per-job progress buffer — the normalized worker events streamed by the active engine. This is the
// source for `check_job`'s "how's it going" read, decoupled from any single engine's internals.
const progress = new Map<string, WorkerEvent[]>();

let counter = 0;
const nextId = () => `job-${(++counter).toString().padStart(3, '0')}`;

export function createJob(
  task: string,
  notifyThread: string,
  engine: WorkerEngineName,
  ownerBot: string,
  company: string,
): Job {
  const id = nextId();
  const job: Job = {
    id,
    task,
    status: 'running',
    threadId: `job:${id}`,
    notifyThread,
    ownerBot,
    company,
    engine,
    turns: 0,
  };
  jobs.set(id, job);
  progress.set(id, []);
  emitter.emit('update', job);
  return job;
}

/** Append a streamed worker event to a job's progress buffer. */
export function appendJobProgress(id: string, event: WorkerEvent): void {
  const buf = progress.get(id);
  if (buf) buf.push(event);
  else progress.set(id, [event]);
}

/** Read a job's accumulated progress events (oldest first). */
export function getJobProgress(id: string): WorkerEvent[] {
  return progress.get(id) ?? [];
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function listJobs(): Job[] {
  return [...jobs.values()];
}

/** Most recently created job (optionally scoped to one owner bot) — used when check_job has no id. */
export function latestJob(ownerBot?: string): Job | undefined {
  const all = ownerBot ? listJobs().filter((j) => j.ownerBot === ownerBot) : listJobs();
  return all[all.length - 1];
}

export function updateJob(id: string, patch: Partial<Omit<Job, 'id'>>): Job | undefined {
  const job = jobs.get(id);
  if (!job) return undefined;
  Object.assign(job, patch);
  emitter.emit('update', job);
  return job;
}

/** Subscribe to job lifecycle changes. Returns an unsubscribe function. */
export function onJobUpdate(cb: (job: Job) => void): () => void {
  emitter.on('update', cb);
  return () => emitter.off('update', cb);
}
