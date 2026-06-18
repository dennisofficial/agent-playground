import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import type { WorkerEvent } from '../engines/worker-engine.port';
import type {
  NewSession,
  Session,
  SessionRegistry,
  SessionStatus,
} from './session-registry.port';

/**
 * v0 in-process session registry — the connective tissue between the chat layer and the worker.
 * In-memory Map behind the async `SessionRegistry` port: sessions vanish on restart (their
 * workspaces are durable and re-adopted), `onUpdate` fires only within this process. The port is
 * the swap point for a Postgres upgrade.
 */
@Injectable()
export class InMemorySessionRegistry implements SessionRegistry {
  private sessions = new Map<string, Session>();
  private transcripts = new Map<string, WorkerEvent[]>();
  private emitter = new EventEmitter();
  private counter = 0;

  async create(input: NewSession): Promise<Session> {
    const id = `sess-${(++this.counter).toString().padStart(3, '0')}`;
    const session: Session = {
      id,
      task: input.task,
      workspaceId: input.workspaceId,
      status: 'running', // create_session fires the first turn immediately
      notifyThread: input.notifyThread,
      ownerBot: input.ownerBot,
      team: input.team,
      project: input.project,
      engine: input.engine,
      mode: input.mode,
      turns: 0,
      ...(input.boardTaskId !== undefined
        ? { boardTaskId: input.boardTaskId }
        : {}),
    };
    this.sessions.set(id, session);
    this.transcripts.set(id, []);
    this.emitter.emit('update', session);
    return session;
  }

  async get(id: string): Promise<Session | undefined> {
    return this.sessions.get(id);
  }

  async list(filter?: {
    ownerBot?: string;
    status?: SessionStatus;
    workspaceId?: string;
  }): Promise<Session[]> {
    let all = [...this.sessions.values()];
    if (filter?.ownerBot)
      all = all.filter((s) => s.ownerBot === filter.ownerBot);
    if (filter?.status) all = all.filter((s) => s.status === filter.status);
    if (filter?.workspaceId)
      all = all.filter((s) => s.workspaceId === filter.workspaceId);
    return all;
  }

  async latest(ownerBot?: string): Promise<Session | undefined> {
    const all = await this.list(ownerBot ? { ownerBot } : undefined);
    return all[all.length - 1];
  }

  async update(
    id: string,
    patch: Partial<Omit<Session, 'id'>>,
  ): Promise<Session | undefined> {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    Object.assign(session, patch);
    this.emitter.emit('update', session);
    return session;
  }

  async appendProgress(id: string, event: WorkerEvent): Promise<void> {
    const buf = this.transcripts.get(id);
    if (buf) buf.push(event);
    else this.transcripts.set(id, [event]);
  }

  async progress(id: string): Promise<WorkerEvent[]> {
    return this.transcripts.get(id) ?? [];
  }

  onUpdate(cb: (session: Session) => void): () => void {
    this.emitter.on('update', cb);
    return () => this.emitter.off('update', cb);
  }
}
