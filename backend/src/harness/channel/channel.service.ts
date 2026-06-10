import { EnvService } from '@core/config/env/env.service';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ChannelMessage } from '@workspace/shared/schemas';
import { Repository } from 'typeorm';
import type { ChannelMsg } from './channel.types';

export const DEFAULT_SURFACE_ID = 'tui:main';
const DEFAULT_HYDRATE_LIMIT = 500;

/**
 * The channel, with durable history. The in-memory log stays the SYNCHRONOUS source of truth —
 * `append()` never blocks a turn, because the bot-graph's llm node reads `since(cursor)` at the top
 * of every step (mid-thought collaboration) and the gate reads `historyBefore` windows. Postgres is
 * write-behind durability: every append/update is queued onto a serialized persist chain (ordering
 * holds; failures are logged, never thrown into a turn), and boot re-hydrates the tail of the log +
 * the seq counter so cursors and history survive restarts.
 *
 * One surface per process this pass (`HARNESS_SURFACE_ID`); multi-surface arrives with the Slack
 * adapter.
 */
@Injectable()
export class ChannelService implements OnModuleInit {
  private readonly logger = new Logger(ChannelService.name);
  private log: ChannelMsg[] = [];
  private subs = new Set<() => void>();
  private nextSeq = 0;
  private writeChain: Promise<void> = Promise.resolve();

  readonly surfaceId: string;

  constructor(
    @InjectRepository(ChannelMessage) private readonly repo: Repository<ChannelMessage>,
    env: EnvService,
  ) {
    this.surfaceId = env.get('HARNESS_SURFACE_ID') ?? DEFAULT_SURFACE_ID;
    this.hydrateLimit = env.get('CHANNEL_HYDRATE_LIMIT') ?? DEFAULT_HYDRATE_LIMIT;
  }

  private readonly hydrateLimit: number;

  /** Boot hydration: seq counter + the tail of the log. Runs before any conductor bootstrap hook. */
  async onModuleInit(): Promise<void> {
    const rows = await this.repo.find({
      where: { surface_id: this.surfaceId },
      order: { seq: 'DESC' },
      take: this.hydrateLimit,
    });
    rows.reverse();
    this.log = rows.map((r) => ({
      seq: Number(r.seq),
      id: r.id,
      author: r.author,
      authorId: r.author_id,
      authorBotId: r.author_bot_id ?? undefined,
      text: r.text,
    }));
    const max = await this.repo
      .createQueryBuilder('m')
      .select('MAX(m.seq)', 'max')
      .where('m.surface_id = :surface', { surface: this.surfaceId })
      .getRawOne<{ max: string | null }>();
    this.nextSeq = max?.max != null ? Number(max.max) + 1 : 0;
    if (this.log.length) {
      this.logger.log(`Hydrated ${this.log.length} channel message(s) for '${this.surfaceId}' (next seq ${this.nextSeq})`);
    }
  }

  /** Append a message (or update one re-emitted with the same id). Synchronous, never blocks. */
  append(msg: Omit<ChannelMsg, 'seq'>): ChannelMsg {
    const existing = this.log.findIndex((m) => m.id === msg.id);
    if (existing >= 0) {
      this.log[existing] = { ...this.log[existing], ...msg };
      const updated = this.log[existing];
      this.persist(updated);
      this.notify();
      return updated;
    }
    const full: ChannelMsg = { ...msg, seq: this.nextSeq++ };
    this.log.push(full);
    this.persist(full);
    this.notify();
    return full;
  }

  /** Messages at or after a cursor seq (what a bot hasn't consumed yet). */
  since(cursor: number): ChannelMsg[] {
    return this.log.filter((m) => m.seq >= cursor);
  }

  /** The next seq that will be assigned — the high-water cursor. */
  get length(): number {
    return this.nextSeq;
  }

  snapshot(): ChannelMsg[] {
    return [...this.log];
  }

  subscribe(cb: () => void): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }

  /** Await all queued writes (shutdown / tests). */
  flush(): Promise<void> {
    return this.writeChain;
  }

  private persist(msg: ChannelMsg): void {
    // Serialized write-behind: ordering holds, and a failed write never surfaces into a turn.
    this.writeChain = this.writeChain
      .then(() =>
        this.repo.upsert(
          {
            id: msg.id,
            seq: String(msg.seq),
            surface_id: this.surfaceId,
            author: msg.author,
            author_id: msg.authorId,
            author_bot_id: msg.authorBotId ?? null,
            text: msg.text,
          },
          ['id'],
        ),
      )
      .then(
        () => undefined,
        (err) => this.logger.error(`Failed to persist channel message ${msg.id}: ${err}`),
      );
  }

  private notify(): void {
    for (const cb of this.subs) cb();
  }
}
