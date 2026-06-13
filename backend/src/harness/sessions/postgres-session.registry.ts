import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import {
  Session as SessionEntity,
  SessionEvent as SessionEventEntity,
} from '@workspace/shared/schemas';
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
 * The transcript is durable too: every streamed event lands in `session_events` (the SINGLE source
 * of truth check_session/searchTranscript read), so narration survives a restart. `onUpdate`
 * subscriptions stay in-process (single-process harness, so this is sufficient). On boot, any
 * `running` row whose process died is reconciled to 'failed' — safe because only one process
 * composes the harness at a time.
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
  // In-process update fan-out (session lifecycle changes → the conductor's relay). The transcript
  // itself lives in `session_events`, not in memory.
  private readonly emitter = new EventEmitter();

  constructor(
    @InjectRepository(SessionEntity)
    private readonly repo: Repository<SessionEntity>,
    @InjectRepository(SessionEventEntity)
    private readonly events: Repository<SessionEventEntity>,
  ) {}

  /** Reconcile sessions left `running` when the process died — their turn (and AbortController) is
   * gone. Mark 'failed' so the owner can reply to resume (engine session preserved) or close. Also
   * logs the survival count so a restart visibly proves sessions persisted. */
  async onApplicationBootstrap(): Promise<void> {
    // The error message must tell the TRUTH per session: a session with an engine_session_id (≥1
    // completed turn) genuinely resumes with full context; one killed before its first turn finished
    // (no handle) has nothing to resume and must restart from the task. An unconditional "context is
    // preserved" would mislead a bot into reply_session expecting context that isn't there.
    const withCtx =
      'Interrupted by a harness restart — reply_session resumes it with full context (the engine session was preserved), or close_session to drop it.';
    const noCtx =
      'Interrupted by a harness restart before its first turn finished — there is no saved context to resume; reply_session restarts it from the original task, or close_session to drop it.';
    const interrupted = await this.repo.count({
      where: { status: 'running' },
    });
    if (interrupted)
      await this.repo.manager.query(
        `UPDATE sessions SET status = 'failed', updated_at = now(),
           error = CASE WHEN engine_session_id IS NOT NULL THEN $1 ELSE $2 END
         WHERE status = 'running'`,
        [withCtx, noCtx],
      );
    // Survival readout: idle/failed sessions are the ones a teammate can still pick back up.
    const open = await this.repo.count({
      where: [{ status: 'idle' }, { status: 'failed' }],
    });
    this.logger.log(
      `Sessions hydrated from Postgres: ${open} open${interrupted ? `, ${interrupted} interrupted → 'failed' this boot` : ''}.`,
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

  /** Append one streamed event to the durable transcript (called fire-and-forget per event). */
  async appendProgress(id: string, event: WorkerEvent): Promise<void> {
    await this.events.insert({
      session_id: id,
      kind: event.kind,
      text: event.kind === 'tool' ? null : event.text,
      name: event.kind === 'tool' ? event.name : null,
      detail: event.kind === 'tool' ? (event.detail ?? null) : null,
    });
  }

  /** The full transcript for a session, oldest first — the single source of truth. */
  async progress(id: string): Promise<WorkerEvent[]> {
    const rows = await this.events.find({
      where: { session_id: id },
      order: { id: 'ASC' },
    });
    return rows.map((r) =>
      r.kind === 'tool'
        ? {
            kind: 'tool',
            name: r.name ?? '',
            ...(r.detail != null ? { detail: r.detail } : {}),
          }
        : { kind: r.kind as 'text' | 'result', text: r.text ?? '' },
    );
  }

  onUpdate(cb: (session: Session) => void): () => void {
    this.emitter.on('update', cb);
    return () => this.emitter.off('update', cb);
  }
}
