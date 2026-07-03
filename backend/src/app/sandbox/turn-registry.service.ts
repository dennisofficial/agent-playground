import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Not, QueryFailedError, Repository } from 'typeorm';
import { DB_CONNECTION } from '../persistence/database.module';
import { ActiveTurnEntity, ToolExecutionEntity } from '../persistence/entities';

/** Postgres unique-violation SQLSTATE. */
const PG_UNIQUE_VIOLATION = '23505';

/**
 * Raised when {@link TurnRegistry.register} is rejected by the partial unique index
 * `ux_active_turns_one_running_brain_per_job` — i.e. a `running` brain turn already exists for this job.
 * The HARD cross-process backstop against two brain turns resuming one engine session concurrently (the
 * "parallel co-author" bug). The runner must NOT kick a second engine on this; the caller steers the
 * stimulus into the existing live turn instead.
 */
export class BrainTurnAlreadyRunningError extends Error {
  constructor(public readonly jobId: string) {
    super(`A brain turn is already running for job ${jobId}`);
    this.name = 'BrainTurnAlreadyRunningError';
  }
}

/** The context a fresh host needs to rebuild a turn's harness (+ brain `buildTools` closure) on re-attach. */
export interface TurnContext {
  orgId?: string;
  repoId?: string;
  jobId?: string;
  /** Free-form per-kind params (author, prompt body, route, session id, timeouts, …). */
  [k: string]: unknown;
}

export interface RegisterTurnInput {
  turnId: string;
  jobId: string;
  orgId: string;
  channel: string;
  lane: string;
  kind: ActiveTurnEntity['kind'];
  containerId?: string | null;
  ctx: TurnContext;
}

/**
 * The durable registry of in-flight Redis-transport turns (`active_turns`). Thin CRUD over the entity:
 * the runner `register`s a turn on start, `heartbeat`s + `advanceCursor`s as it tails events, and
 * `finalize`s it on completion; the boot re-attach reads `listRunning`, and the watchdog reads
 * `findStale`. See ADR 0001 + `ActiveTurnEntity`.
 */
@Injectable()
export class TurnRegistry {
  constructor(
    @InjectRepository(ActiveTurnEntity, DB_CONNECTION)
    private readonly turns: Repository<ActiveTurnEntity>,
    @InjectRepository(ToolExecutionEntity, DB_CONNECTION)
    private readonly toolExecs: Repository<ToolExecutionEntity>,
  ) {}

  /** The cached reply for an already-executed tool call, or null (idempotency on redelivery). */
  async getToolReply(turnId: string, toolCallId: string): Promise<Record<string, unknown> | null> {
    const row = await this.toolExecs.findOne({
      where: { turn_id: turnId, tool_call_id: toolCallId },
    });
    return row ? row.reply : null;
  }

  /** Record a tool call's reply BEFORE acking, so a redelivery re-posts it instead of re-executing. */
  async recordToolReply(
    turnId: string,
    toolCallId: string,
    toolName: string,
    reply: Record<string, unknown>,
  ): Promise<void> {
    await this.toolExecs.save(
      this.toolExecs.create({ turn_id: turnId, tool_call_id: toolCallId, tool_name: toolName, reply }),
    );
  }

  /**
   * Record a newly-started turn as `running` (each turn has a fresh `turn_id`, so this always INSERTs — a
   * re-attach resumes the existing row rather than re-registering). For a `brain` turn the partial unique
   * index enforces at most one `running` brain turn per job: a racing second registration (a reattached or
   * concurrent turn already running) is rejected here as {@link BrainTurnAlreadyRunningError}, so the runner
   * aborts the kick and the caller steers into the live turn instead of spawning a second engine.
   */
  async register(input: RegisterTurnInput): Promise<void> {
    try {
      // `save` on a fresh `turn_id` (every turn has one; re-attach never re-registers) INSERTs, so the
      // partial unique index on (job_id) WHERE brain+running is what a racing second brain turn violates.
      await this.turns.save(
        this.turns.create({
          turn_id: input.turnId,
          job_id: input.jobId,
          org_id: input.orgId,
          channel: input.channel,
          lane: input.lane,
          kind: input.kind,
          container_id: input.containerId ?? null,
          status: 'running',
          events_last_id: '0-0',
          last_heartbeat_at: null,
          ctx: input.ctx,
        }),
      );
    } catch (err) {
      if (
        input.kind === 'brain' &&
        err instanceof QueryFailedError &&
        (err as QueryFailedError & { code?: string }).code === PG_UNIQUE_VIOLATION
      ) {
        throw new BrainTurnAlreadyRunningError(input.jobId);
      }
      throw err;
    }
  }

  /** Stamp a heartbeat (engine liveness) and, when given, advance the event-tail resume cursor. */
  async heartbeat(turnId: string, lastEventId?: string, at: Date = new Date()): Promise<void> {
    const patch: { last_heartbeat_at: Date; events_last_id?: string } = { last_heartbeat_at: at };
    if (lastEventId) patch.events_last_id = lastEventId;
    await this.turns.update({ turn_id: turnId }, patch);
  }

  /** Advance only the resume cursor (the id of the last `events` entry consumed). */
  async advanceCursor(turnId: string, lastEventId: string): Promise<void> {
    await this.turns.update({ turn_id: turnId }, { events_last_id: lastEventId });
  }

  /**
   * Stamp a fresh heartbeat on EVERY running turn — the leader's boot grace touch. Heartbeats are relayed by
   * an attached host, so a backend restart freezes `last_heartbeat_at`; without this, a turn whose engine is
   * alive but whose DB heartbeat aged past the stale window is finalized by the watchdog the instant the
   * leader promotes, before boot re-attach can resume it (and race it). Touching all running turns once at
   * promotion gives each a full stale window to re-attach (resuming real heartbeats) or prove genuinely dead.
   */
  async touchAllRunningHeartbeats(at: Date = new Date()): Promise<void> {
    await this.turns.update({ status: 'running' }, { last_heartbeat_at: at });
  }

  /** Mark a turn terminal and drop it from the live set (the durable transcript lives in `messages`). */
  async finalize(turnId: string, status: 'done' | 'failed'): Promise<void> {
    // Stamp the terminal status first (audit/observability), then remove the live row.
    await this.turns.update({ turn_id: turnId }, { status });
    await this.turns.delete({ turn_id: turnId });
  }

  /**
   * Drop every still-`running` turn for a job — called when its sandbox container is torn down out from
   * under it (idle-reap / reset / LRU detach). Leaving the row `running` lets the steer path treat a dead
   * engine as live (the operator message is XADD'd to an unread input stream and silently lost) until the
   * watchdog's stale window finally cleans it. Returns how many rows were dropped.
   */
  async failRunningForJob(jobId: string): Promise<number> {
    const res = await this.turns.delete({ job_id: jobId, status: 'running' });
    return res.affected ?? 0;
  }

  /** Load one turn (for re-attach context rebuild). */
  async get(turnId: string): Promise<ActiveTurnEntity | null> {
    return this.turns.findOne({ where: { turn_id: turnId } });
  }

  /** Every turn still `running` — the boot re-attach worklist. */
  async listRunning(): Promise<ActiveTurnEntity[]> {
    return this.turns.find({ where: { status: 'running' } });
  }

  /**
   * The turn ids of EVERY live row (all statuses) — the reaper's exclusion set. Including terminal
   * `done`/`failed` rows (which normally get deleted immediately by `finalize`, but can briefly linger)
   * keeps the reaper from racing a concurrent finalize and reaping a turn's streams out from under it.
   */
  async allTurnIds(): Promise<Set<string>> {
    const rows = await this.turns.find({ select: { turn_id: true } });
    return new Set(rows.map((r) => r.turn_id));
  }

  /**
   * Running turns whose last heartbeat is older than `thresholdMs` (or which never beat and were
   * started before the cutoff) — the watchdog's "the engine container died" worklist.
   */
  async findStale(thresholdMs: number, now: Date = new Date()): Promise<ActiveTurnEntity[]> {
    const cutoff = new Date(now.getTime() - thresholdMs);
    // Heartbeat gone stale.
    const beat = await this.turns.find({
      where: { status: 'running', last_heartbeat_at: LessThan(cutoff) },
    });
    // Never beat yet, but started before the cutoff (engine died before its first heartbeat).
    const neverBeat = await this.turns.find({
      where: { status: 'running', last_heartbeat_at: null as never, created_at: LessThan(cutoff) },
    });
    const seen = new Set(beat.map((t) => t.turn_id));
    return [...beat, ...neverBeat.filter((t) => !seen.has(t.turn_id))];
  }

  /**
   * The running BRAIN turn for a thread (the operator-facing Claude Code session), or null. The steer/stop
   * routing resolves the live turnId through this — durable, so it survives a host restart mid-turn.
   */
  async runningBrainTurn(jobId: string): Promise<ActiveTurnEntity | null> {
    return this.turns.findOne({ where: { job_id: jobId, kind: 'brain', status: 'running' } });
  }

  /** True if any turn for this thread is still running (guards a duplicate dispatch). */
  async hasRunningForThread(jobId: string): Promise<boolean> {
    return (
      (await this.turns.count({
        where: { job_id: jobId, status: Not('failed') as never },
      })) > 0
    );
  }
}
