import { EnvService } from '@core/config/env/env.service';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ChannelMessage } from '@workspace/shared/schemas';
import { Repository } from 'typeorm';
import { createMutex } from '../domain/async';
import type { ChannelMsg } from './channel.types';

export const DEFAULT_SURFACE_ID = 'tui:main';
const DEFAULT_HYDRATE_LIMIT = 500;

/** One room's in-memory log. `seq` is monotonic PER ROOM — each room is its own cursor space. */
interface RoomLog {
  msgs: ChannelMsg[];
  nextSeq: number;
  /** The lowest seq held in memory (== nextSeq when the log is empty). */
  floor: number;
}

/**
 * The conversation logs — one per room — with durable history. The in-memory logs stay the
 * SYNCHRONOUS source of truth: `append()` never blocks a turn, because the bot-graph's llm node
 * reads `since(cursor, channelId)` at the top of every step (mid-thought collaboration) and the
 * gate reads `historyBefore` windows. Postgres is write-behind durability: every append/update is
 * queued onto a serialized persist chain (ordering holds; failures are logged, never thrown into a
 * turn), and boot re-hydrates the tail of every room's log + its seq counter so cursors and history
 * survive restarts.
 *
 * Hydration is a TAIL per room (the newest `CHANNEL_HYDRATE_LIMIT` rows), so a durable cursor can
 * point BELOW the in-memory window — `floorSeqOf` exposes a room's lower edge and `backfillTo()`
 * loads the gap on demand. The conductor reconciles cursors against the floors at bootstrap so no
 * message between a bot's cursor and the window is ever silently skipped.
 *
 * `surfaceId` is this process's DEFAULT room (`HARNESS_SURFACE_ID`) — the channelId every read/write
 * falls back to when none is given. Which rooms exist, their kind/project/membership, lives in the
 * ChannelRegistryService; this service only owns the logs.
 */
@Injectable()
export class ChannelService implements OnModuleInit {
  private readonly logger = new Logger(ChannelService.name);
  private rooms = new Map<string, RoomLog>();
  private subs = new Set<() => void>();
  private readonly write = createMutex();
  private readonly hydrateLimit: number;

  readonly surfaceId: string;

  constructor(
    @InjectRepository(ChannelMessage)
    private readonly repo: Repository<ChannelMessage>,
    env: EnvService,
  ) {
    this.surfaceId = env.get('HARNESS_SURFACE_ID') ?? DEFAULT_SURFACE_ID;
    this.hydrateLimit =
      env.get('CHANNEL_HYDRATE_LIMIT') ?? DEFAULT_HYDRATE_LIMIT;
  }

  /** Boot hydration: every room's tail + seq counter. Runs before any conductor bootstrap hook. */
  async onModuleInit(): Promise<void> {
    // Newest `hydrateLimit` rows PER ROOM, one round-trip (rn=1 is the newest row of each room).
    // Raw query (window function), so rows are plain snake_case records, not entities.
    const rows: ChannelMessage[] = await this.repo.query(
      `SELECT * FROM (
         SELECT *, ROW_NUMBER() OVER (PARTITION BY surface_id ORDER BY seq DESC) AS rn
         FROM channel_messages
       ) t WHERE rn <= $1 ORDER BY surface_id, seq ASC`,
      [this.hydrateLimit],
    );
    for (const r of rows) {
      const room = this.room(r.surface_id);
      room.msgs.push(toChannelMsg(r));
      room.nextSeq = Math.max(room.nextSeq, Number(r.seq) + 1);
    }
    for (const [id, room] of this.rooms) {
      room.floor = room.msgs.length ? room.msgs[0].seq : room.nextSeq;
      this.logger.log(
        `Hydrated ${room.msgs.length} message(s) for '${id}' (seq ${room.floor}…${room.nextSeq - 1})`,
      );
    }
  }

  /** Every room that currently holds (or held) messages. The registry, not this, defines rooms. */
  channelIds(): string[] {
    return [...this.rooms.keys()];
  }

  /** A room's lowest in-memory seq. Cursors below it need `backfillTo` before `since` is complete. */
  floorSeqOf(channelId: string = this.surfaceId): number {
    return this.room(channelId).floor;
  }

  /** Back-compat: the default room's floor. */
  get floorSeq(): number {
    return this.floorSeqOf();
  }

  /**
   * Load a room's older persisted messages down to `seq` (inclusive) into the in-memory log, so
   * `since()` over a cursor below the hydration window returns the TRUE delta instead of silently
   * skipping the gap. Called by the conductor at bootstrap with the lowest bot cursor per room.
   */
  async backfillTo(
    seq: number,
    channelId: string = this.surfaceId,
  ): Promise<void> {
    const room = this.room(channelId);
    if (seq >= room.floor) return;
    const rows = await this.repo
      .createQueryBuilder('m')
      .where('m.surface_id = :surface', { surface: channelId })
      .andWhere('m.seq >= :from AND m.seq < :to', {
        from: String(seq),
        to: String(room.floor),
      })
      .orderBy('m.seq', 'ASC')
      .getMany();
    if (rows.length) {
      room.msgs = [...rows.map(toChannelMsg), ...room.msgs];
      this.logger.log(
        `Backfilled ${rows.length} message(s) for '${channelId}' (seq ${seq}…${room.floor - 1})`,
      );
    }
    room.floor = Math.min(room.floor, seq);
  }

  /** Append a message (or update one re-emitted with the same id). Synchronous, never blocks.
   * `channelId` defaults to this process's default room; identity is (channelId, id).
   * `createdAt` is intentionally OMITTED from the input type: callers never supply it — new rows
   * are stamped with `Date.now()` here, and streaming re-emits preserve the original stamp. */
  append(
    msg: Omit<ChannelMsg, 'seq' | 'channelId' | 'createdAt'> & {
      channelId?: string;
    },
  ): ChannelMsg {
    const channelId = msg.channelId ?? this.surfaceId;
    const room = this.room(channelId);
    const existing = room.msgs.findIndex((m) => m.id === msg.id);
    if (existing >= 0) {
      // Re-emit (streaming edit): update all fields EXCEPT createdAt — the original stamp holds.
      room.msgs[existing] = { ...room.msgs[existing], ...msg, channelId };
      const updated = room.msgs[existing];
      this.persist(updated);
      this.notify();
      return updated;
    }
    const full: ChannelMsg = {
      ...msg,
      channelId,
      seq: room.nextSeq++,
      createdAt: Date.now(),
    };
    room.msgs.push(full);
    this.persist(full);
    this.notify();
    return full;
  }

  /** A room's messages at or after a cursor seq (what a bot hasn't consumed there yet). */
  since(cursor: number, channelId: string = this.surfaceId): ChannelMsg[] {
    return this.room(channelId).msgs.filter((m) => m.seq >= cursor);
  }

  /** The next seq a room will assign — its high-water cursor. */
  lengthOf(channelId: string = this.surfaceId): number {
    return this.room(channelId).nextSeq;
  }

  /** Back-compat: the default room's high-water cursor. */
  get length(): number {
    return this.lengthOf();
  }

  snapshot(channelId: string = this.surfaceId): ChannelMsg[] {
    return [...this.room(channelId).msgs];
  }

  subscribe(cb: () => void): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }

  /** Await all queued writes (shutdown / tests). */
  flush(): Promise<void> {
    return this.write(async () => {});
  }

  private room(channelId: string): RoomLog {
    let room = this.rooms.get(channelId);
    if (!room) {
      room = { msgs: [], nextSeq: 0, floor: 0 };
      this.rooms.set(channelId, room);
    }
    return room;
  }

  private persist(msg: ChannelMsg): void {
    // Serialized write-behind: ordering holds, and a failed write never surfaces into a turn.
    // Note: `created_at` is NOT included in the upsert payload — it is DB-authoritative via the
    // `DEFAULT now()` column (set once on INSERT, never touched on UPDATE because of `update:false`
    // on the `@CreateDateColumn`). The in-memory `createdAt` (stamped by `Date.now()` in `append`)
    // and the persisted `created_at` can therefore diverge by the write-behind queue latency, which
    // is immaterial at the hour-scale granularity used for time-dividers. Intentional design choice.
    void this.write(() =>
      this.repo.upsert(
        {
          id: msg.id,
          seq: String(msg.seq),
          surface_id: msg.channelId,
          author: msg.author,
          author_id: msg.authorId,
          author_bot_id: msg.authorBotId ?? null,
          text: msg.text,
        },
        ['surface_id', 'id'],
      ),
    ).catch((err) =>
      this.logger.error(`Failed to persist channel message ${msg.id}: ${err}`),
    );
  }

  private notify(): void {
    for (const cb of this.subs) cb();
  }
}

const toChannelMsg = (r: ChannelMessage): ChannelMsg => ({
  seq: Number(r.seq),
  id: r.id,
  channelId: r.surface_id,
  author: r.author,
  authorId: r.author_id,
  authorBotId: r.author_bot_id ?? undefined,
  text: r.text,
  createdAt: new Date(r.created_at).getTime(),
});
