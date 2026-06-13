import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { Session as SessionEntity } from '@workspace/shared/schemas';
import { Repository } from 'typeorm';
import {
  EWorkerEngineName,
  WorkerEvent,
  WorkerMode,
} from '../engines/worker-engine.port';
import { EventEmitter } from 'node:events';
import type {
  NewSession,
  Session,
  SessionRegistry,
  SessionStatus,
} from './session-registry.port';

/**
 * Durable session registry — the Postgres swap for InMemorySessionRegistry, behind the same
 * SESSION_REGISTRY port. Session ROWS survive restarts (carrying `engine_session_id`, the engine's
 * resume handle), so a reply after a restart resumes the on-disk SDK transcript by id.
 *
 * Still in-memory (and lost on restart, by design): the transcript event BUFFER (check_session
 * narration — the SDK's JSONL under the engine home is the real record) and `onUpdate` subscriptions
 * (single-process harness, so this is sufficient). On boot, any `running` row whose process died is
 * reconciled to 'failed' — safe because only one process composes the harness at a time.
 */

/** camelCase domain key → snake_case entity column, for partial updates. */
const COLUMN: Record<string, keyof SessionEntity> = {
  task: 'task',
  worktreeId: 'worktree_id',
  status: 'status',
  notifyThread: 'notify_thread',
  ownerBot: 'owner_bot',
  team: 'team',
  project: 'project',
  engine: 'engine',
  mode: 'mode',
  engineSessionId: 'engine_session_id',
  turns: 'turns',
  lastReport: 'last_report',
  lastReportKind: 'last_report_kind',
  qa: 'qa',
  boardTaskId: 'board_task_id',
  planAttached: 'plan_attached',
  error: 'error',
};

function toDomain(r: SessionEntity): Session {
  return {
    id: r.id,
    task: r.task,
    worktreeId: r.worktree_id,
    status: r.status as SessionStatus,
    notifyThread: r.notify_thread,
    ownerBot: r.owner_bot,
    team: r.team,
    project: r.project,
    engine: r.engine as EWorkerEngineName,
    mode: r.mode as WorkerMode,
    turns: r.turns,
    // Optional fields are present only when set, mirroring the in-memory registry's shape.
    ...(r.engine_session_id != null
      ? { engineSessionId: r.engine_session_id }
      : {}),
    ...(r.last_report != null ? { lastReport: r.last_report } : {}),
    ...(r.last_report_kind != null
      ? { lastReportKind: r.last_report_kind as 'plan' | 'questions' }
      : {}),
    ...(r.qa != null ? { qa: r.qa } : {}),
    ...(r.board_task_id != null ? { boardTaskId: r.board_task_id } : {}),
    ...(r.plan_attached != null ? { planAttached: r.plan_attached } : {}),
    ...(r.error != null ? { error: r.error } : {}),
  };
}

@Injectable()
export class PostgresSessionRegistry
  implements SessionRegistry, OnApplicationBootstrap
{
  private readonly logger = new Logger(PostgresSessionRegistry.name);
  // Transcript event buffers (ephemeral — narration only) and in-process update fan-out.
  private readonly transcripts = new Map<string, WorkerEvent[]>();
  private readonly emitter = new EventEmitter();

  constructor(
    @InjectRepository(SessionEntity)
    private readonly repo: Repository<SessionEntity>,
  ) {}

  /** Reconcile sessions left `running` when the process died — their turn (and AbortController) is
   * gone. Mark 'failed' so the owner can reply to resume (engine session preserved) or close. */
  async onApplicationBootstrap(): Promise<void> {
    const res = await this.repo.update(
      { status: 'running' },
      {
        status: 'failed',
        error:
          'Interrupted by a harness restart — reply_session to resume (the engine session is preserved) or close_session to drop it.',
      },
    );
    if (res.affected)
      this.logger.warn(
        `Reconciled ${res.affected} interrupted session(s) to 'failed' after restart.`,
      );
  }

  async create(input: NewSession): Promise<Session> {
    const entity = this.repo.create({
      id: `sess-${randomUUID().slice(0, 8)}`,
      task: input.task,
      worktree_id: input.worktreeId,
      status: 'running', // create_session fires the first turn immediately
      notify_thread: input.notifyThread,
      owner_bot: input.ownerBot,
      team: input.team,
      project: input.project,
      engine: input.engine,
      mode: input.mode,
      turns: 0,
      board_task_id: input.boardTaskId ?? null,
    });
    const saved = await this.repo.save(entity);
    this.transcripts.set(saved.id, []);
    const session = toDomain(saved);
    this.emitter.emit('update', session);
    return session;
  }

  async get(id: string): Promise<Session | undefined> {
    const row = await this.repo.findOne({ where: { id } });
    return row ? toDomain(row) : undefined;
  }

  async list(filter?: {
    ownerBot?: string;
    status?: SessionStatus;
    worktreeId?: string;
  }): Promise<Session[]> {
    const where: Record<string, unknown> = {};
    if (filter?.ownerBot) where.owner_bot = filter.ownerBot;
    if (filter?.status) where.status = filter.status;
    if (filter?.worktreeId) where.worktree_id = filter.worktreeId;
    const rows = await this.repo.find({
      where,
      // Creation order — `latest()` and the in-memory registry both relied on insertion order.
      order: { created_at: 'ASC', id: 'ASC' },
    });
    return rows.map(toDomain);
  }

  async latest(ownerBot?: string): Promise<Session | undefined> {
    const row = await this.repo.findOne({
      where: ownerBot ? { owner_bot: ownerBot } : {},
      order: { created_at: 'DESC', id: 'DESC' },
    });
    return row ? toDomain(row) : undefined;
  }

  async update(
    id: string,
    patch: Partial<Omit<Session, 'id'>>,
  ): Promise<Session | undefined> {
    const set: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) {
      const col = COLUMN[k];
      if (!col) continue;
      // The runner writes some keys with `undefined` to CLEAR them (lastReportKind, planAttached) —
      // present-but-undefined means NULL, not "leave alone".
      set[col] = v === undefined ? null : v;
    }
    if (Object.keys(set).length > 0) await this.repo.update({ id }, set);
    const row = await this.repo.findOne({ where: { id } });
    if (!row) return undefined;
    const session = toDomain(row);
    this.emitter.emit('update', session);
    return session;
  }

  // Transcript buffer is in-memory (narration only), so these are sync behind the async port.
  appendProgress(id: string, event: WorkerEvent): Promise<void> {
    const buf = this.transcripts.get(id);
    if (buf) buf.push(event);
    else this.transcripts.set(id, [event]);
    return Promise.resolve();
  }

  progress(id: string): Promise<WorkerEvent[]> {
    return Promise.resolve(this.transcripts.get(id) ?? []);
  }

  onUpdate(cb: (session: Session) => void): () => void {
    this.emitter.on('update', cb);
    return () => this.emitter.off('update', cb);
  }
}
