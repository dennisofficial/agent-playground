import { EventEmitter } from 'node:events';

export type JobStatus = 'running' | 'done' | 'failed';

export interface Job {
  id: string;
  task: string;
  status: JobStatus;
  threadId: string;
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

let counter = 0;
const nextId = () => `job-${(++counter).toString().padStart(3, '0')}`;

export function createJob(task: string): Job {
  const id = nextId();
  const job: Job = { id, task, status: 'running', threadId: `job:${id}` };
  jobs.set(id, job);
  emitter.emit('update', job);
  return job;
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function listJobs(): Job[] {
  return [...jobs.values()];
}

/** Most recently created job, if any — used when check_job is called without an id. */
export function latestJob(): Job | undefined {
  const all = listJobs();
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
