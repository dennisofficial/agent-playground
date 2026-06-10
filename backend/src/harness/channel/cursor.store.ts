import { EnvService } from '@core/config/env/env.service';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { BotCursor } from '@workspace/shared/schemas';
import { Repository } from 'typeorm';
import { createMutex } from '../domain/async';
import { DEFAULT_SURFACE_ID } from './channel.service';

/**
 * Durable per-bot channel cursors. Reads are synchronous from an in-memory cache (hydrated at
 * boot); writes update the cache immediately and persist write-behind on a serialized chain, so the
 * conductor's scheduling loop never waits on Postgres. A restarted process resumes each bot exactly
 * where it left off — the playground's "channel restarts at seq 0" assumption is inverted here.
 */
@Injectable()
export class CursorStore implements OnModuleInit {
  private readonly logger = new Logger(CursorStore.name);
  private cache = new Map<string, number>();
  private readonly write = createMutex();
  private readonly activeSurfaceId: string;

  constructor(
    @InjectRepository(BotCursor) private readonly repo: Repository<BotCursor>,
    env: EnvService,
  ) {
    this.activeSurfaceId = env.get('HARNESS_SURFACE_ID') ?? DEFAULT_SURFACE_ID;
  }

  async onModuleInit(): Promise<void> {
    const rows = await this.repo.find();
    for (const r of rows)
      this.cache.set(
        this.key(r.bot_id, r.surface_id),
        Number(r.delivered_up_to),
      );
    if (rows.length) this.logger.log(`Hydrated ${rows.length} bot cursor(s)`);
    // Cursors are keyed by surface id, so renaming HARNESS_SURFACE_ID between runs orphans every
    // stored cursor (cache miss → 0) and the bots would re-gate the whole hydrated history. There
    // is no migration path yet — make the drift LOUD instead of silently replaying.
    if (
      rows.length &&
      !rows.some((r) => r.surface_id === this.activeSurfaceId)
    ) {
      this.logger.warn(
        `bot_cursors holds ${rows.length} cursor(s) but NONE for the active surface '${this.activeSurfaceId}' — ` +
          `did HARNESS_SURFACE_ID change? Stored surfaces: ${[...new Set(rows.map((r) => r.surface_id))].join(', ')}. ` +
          `Bots will start from cursor 0 on the active surface.`,
      );
    }
  }

  /** True when this bot has a stored cursor on the surface (distinguishes "new bot" from "at 0"). */
  has(botId: string, surfaceId: string): boolean {
    return this.cache.has(this.key(botId, surfaceId));
  }

  /** The bot's next unconsumed seq on a surface (exclusive high-water mark); 0 when never seen. */
  get(botId: string, surfaceId: string): number {
    return this.cache.get(this.key(botId, surfaceId)) ?? 0;
  }

  /** Advance a bot's cursor. Cache-synchronous; the Postgres upsert is write-behind. */
  set(botId: string, surfaceId: string, deliveredUpTo: number): void {
    this.cache.set(this.key(botId, surfaceId), deliveredUpTo);
    void this.write(() =>
      this.repo.upsert(
        {
          bot_id: botId,
          surface_id: surfaceId,
          delivered_up_to: String(deliveredUpTo),
        },
        ['bot_id', 'surface_id'],
      ),
    ).catch((err) =>
      this.logger.error(
        `Failed to persist cursor ${botId}@${surfaceId}: ${err}`,
      ),
    );
  }

  /** Await all queued writes (shutdown / tests). */
  flush(): Promise<void> {
    return this.write(async () => {});
  }

  private key(botId: string, surfaceId: string): string {
    return `${botId} ${surfaceId}`;
  }
}
