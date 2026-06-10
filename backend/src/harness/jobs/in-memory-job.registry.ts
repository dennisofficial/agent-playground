import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import type { WorkerEvent } from '../engines/worker-engine.port';
import type { Job, JobRegistry, JobStatus, NewJob } from './job-registry.port';

/**
 * v0 in-process job registry — the connective tissue between the chat layer and the worker.
 * In-memory Map behind the async `JobRegistry` port: jobs vanish on restart, `onUpdate` fires only
 * within this process. The port is the swap point for a Postgres/BullMQ upgrade.
 * (Ported from playground/src/jobs.ts.)
 */
@Injectable()
export class InMemoryJobRegistry implements JobRegistry {
  private jobs = new Map<string, Job>();
  private progressBuf = new Map<string, WorkerEvent[]>();
  private emitter = new EventEmitter();
  private counter = 0;

  async create(input: NewJob): Promise<Job> {
    const id = `job-${(++this.counter).toString().padStart(3, '0')}`;
    const job: Job = {
      id,
      task: input.task,
      status: 'running',
      threadId: `job:${id}`,
      notifyThread: input.notifyThread,
      ownerBot: input.ownerBot,
      project: input.project,
      engine: input.engine,
      mode: input.mode,
      turns: 0,
      version: 0,
    };
    this.jobs.set(id, job);
    this.progressBuf.set(id, []);
    this.emitter.emit('update', job);
    return job;
  }

  async get(id: string): Promise<Job | undefined> {
    return this.jobs.get(id);
  }

  async list(filter?: { ownerBot?: string; status?: JobStatus }): Promise<Job[]> {
    let all = [...this.jobs.values()];
    if (filter?.ownerBot) all = all.filter((j) => j.ownerBot === filter.ownerBot);
    if (filter?.status) all = all.filter((j) => j.status === filter.status);
    return all;
  }

  async latest(ownerBot?: string): Promise<Job | undefined> {
    const all = await this.list(ownerBot ? { ownerBot } : undefined);
    return all[all.length - 1];
  }

  async update(id: string, patch: Partial<Omit<Job, 'id'>>): Promise<Job | undefined> {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    Object.assign(job, patch);
    this.emitter.emit('update', job);
    return job;
  }

  async appendProgress(id: string, event: WorkerEvent): Promise<void> {
    const buf = this.progressBuf.get(id);
    if (buf) buf.push(event);
    else this.progressBuf.set(id, [event]);
  }

  async progress(id: string): Promise<WorkerEvent[]> {
    return this.progressBuf.get(id) ?? [];
  }

  onUpdate(cb: (job: Job) => void): () => void {
    this.emitter.on('update', cb);
    return () => this.emitter.off('update', cb);
  }
}
