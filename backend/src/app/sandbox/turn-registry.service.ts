import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Not, Repository } from 'typeorm';
import { DB_CONNECTION } from '../persistence/database.module';
import { ActiveTurnEntity, ToolExecutionEntity } from '../persistence/entities';

/** The context a fresh host needs to rebuild a turn's harness (+ brain `buildTools` closure) on re-attach. */
export interface TurnContext {
  orgId?: string;
  repoId?: string;
  threadId?: string;
  /** Free-form per-kind params (author, prompt body, route, session id, timeouts, …). */
  [k: string]: unknown;
}

export interface RegisterTurnInput {
  turnId: string;
  threadId: string;
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

  /** Record a newly-started turn as `running` (idempotent on turn_id — re-register overwrites). */
  async register(input: RegisterTurnInput): Promise<void> {
    await this.turns.save(
      this.turns.create({
        turn_id: input.turnId,
        thread_id: input.threadId,
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

  /** Mark a turn terminal and drop it from the live set (the durable transcript lives in `messages`). */
  async finalize(turnId: string, status: 'done' | 'failed'): Promise<void> {
    // Stamp the terminal status first (audit/observability), then remove the live row.
    await this.turns.update({ turn_id: turnId }, { status });
    await this.turns.delete({ turn_id: turnId });
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

  /** True if any turn for this thread is still running (guards a duplicate dispatch). */
  async hasRunningForThread(threadId: string): Promise<boolean> {
    return (
      (await this.turns.count({
        where: { thread_id: threadId, status: Not('failed') as never },
      })) > 0
    );
  }
}
