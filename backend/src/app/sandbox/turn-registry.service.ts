import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Not, QueryFailedError, Repository } from 'typeorm';
import { DB_CONNECTION } from '../persistence/database.module';
import { ActiveTurnEntity, ToolExecutionEntity } from '../persistence/entities';

const PG_UNIQUE_VIOLATION = '23505';

export class BrainTurnAlreadyRunningError extends Error {
  constructor(public readonly jobId: string) {
    super(`A brain turn is already running for job ${jobId}`);
    this.name = 'BrainTurnAlreadyRunningError';
  }
}

export interface TurnContext {
  orgId?: string;
  repoId?: string;
  jobId?: string;
  credentialId?: string;
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
  steerable?: boolean;
  ctx: TurnContext;
}

@Injectable()
export class TurnRegistry {
  constructor(
    @InjectRepository(ActiveTurnEntity, DB_CONNECTION)
    private readonly turns: Repository<ActiveTurnEntity>,
    @InjectRepository(ToolExecutionEntity, DB_CONNECTION)
    private readonly toolExecs: Repository<ToolExecutionEntity>,
  ) {}

  async getToolReply(turnId: string, toolCallId: string): Promise<Record<string, unknown> | null> {
    const row = await this.toolExecs.findOne({
      where: { turn_id: turnId, tool_call_id: toolCallId },
    });
    return row ? row.reply : null;
  }

  async recordToolReply(
    turnId: string,
    toolCallId: string,
    toolName: string,
    reply: Record<string, unknown>,
  ): Promise<void> {
    await this.toolExecs.save(
      this.toolExecs.create({
        turn_id: turnId,
        tool_call_id: toolCallId,
        tool_name: toolName,
        reply,
      }),
    );
  }

  async register(input: RegisterTurnInput): Promise<void> {
    try {
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
          steerable: input.steerable ?? false,
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

  async heartbeat(turnId: string, lastEventId?: string, at: Date = new Date()): Promise<void> {
    const patch: { last_heartbeat_at: Date; events_last_id?: string } = {
      last_heartbeat_at: at,
    };
    if (lastEventId) patch.events_last_id = lastEventId;
    await this.turns.update({ turn_id: turnId }, patch);
  }

  async advanceCursor(turnId: string, lastEventId: string): Promise<void> {
    await this.turns.update({ turn_id: turnId }, { events_last_id: lastEventId });
  }

  async touchAllRunningHeartbeats(at: Date = new Date()): Promise<void> {
    await this.turns.update({ status: 'running' }, { last_heartbeat_at: at });
  }

  async finalize(turnId: string, status: 'done' | 'failed'): Promise<boolean> {
    await this.turns.update({ turn_id: turnId }, { status }); // audit status (best-effort)
    const res = await this.turns.delete({ turn_id: turnId });
    return (res.affected ?? 0) > 0; // true = THIS caller deleted the row (unregistered-turn caveat handled in runAttached)
  }

  async failRunningForJob(jobId: string): Promise<number> {
    const res = await this.turns.delete({ job_id: jobId, status: 'running' });
    return res.affected ?? 0;
  }

  async get(turnId: string): Promise<ActiveTurnEntity | null> {
    return this.turns.findOne({ where: { turn_id: turnId } });
  }

  async listRunning(): Promise<ActiveTurnEntity[]> {
    return this.turns.find({ where: { status: 'running' } });
  }

  async allTurnIds(): Promise<Set<string>> {
    const rows = await this.turns.find({ select: { turn_id: true } });
    return new Set(rows.map((r) => r.turn_id));
  }

  async findStale(thresholdMs: number, now: Date = new Date()): Promise<ActiveTurnEntity[]> {
    const cutoff = new Date(now.getTime() - thresholdMs);
    const beat = await this.turns.find({
      where: { status: 'running', last_heartbeat_at: LessThan(cutoff) },
    });
    const neverBeat = await this.turns.find({
      where: {
        status: 'running',
        last_heartbeat_at: null as never,
        created_at: LessThan(cutoff),
      },
    });
    const seen = new Set(beat.map((t) => t.turn_id));
    return [...beat, ...neverBeat.filter((t) => !seen.has(t.turn_id))];
  }

  async runningBrainTurn(jobId: string): Promise<ActiveTurnEntity | null> {
    return this.turns.findOne({
      where: { job_id: jobId, kind: 'brain', status: 'running' },
    });
  }

  async runningSteerableTurn(jobId: string, lane: string): Promise<ActiveTurnEntity | null> {
    return this.turns.findOne({
      where: { job_id: jobId, lane, status: 'running', steerable: true },
    });
  }

  async hasRunningForThread(jobId: string): Promise<boolean> {
    return (
      (await this.turns.count({
        where: { job_id: jobId, status: Not('failed') as never },
      })) > 0
    );
  }
}
