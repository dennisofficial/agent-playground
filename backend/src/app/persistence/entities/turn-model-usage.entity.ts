import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { TimestampedEntity } from '@workspace/shared/schemas';
import { TurnStatsEntity } from './turn-stats.entity';
import { numberColumn } from './numeric.transformer';

/**
 * One row per (turn, model) — the SDK's `result.modelUsage` map exploded into a typed table, so
 * per-model token/cost analytics is a plain GROUP BY with no jsonb digging. This is the layer that
 * finally makes writer-subagent models (e.g. `claude-sonnet-5`) visible; the parent turn is
 * `turn_stats`. `org_id`/`job_id` are denormalized so per-model rollups need no join.
 *
 * Granularity is per-MODEL, not per-role: the SDK aggregates all calls of a model (orchestrator +
 * any subagents on that model) into one entry, so we cannot split orchestrator-opus from subagent-opus
 * within a turn. The turn's role lives on `turn_stats.kind`.
 */
@Entity({ name: 'turn_model_usage' })
@Index(['job_id'])
@Index(['org_id'])
export class TurnModelUsageEntity extends TimestampedEntity {
  /** FK → turn_stats.id; part of the composite PK. */
  @PrimaryColumn({ type: 'uuid' })
  turn_stats_id!: string;

  @ManyToOne(() => TurnStatsEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'turn_stats_id' })
  turn?: TurnStatsEntity;

  /** The model id (e.g. 'claude-opus-4-8', 'claude-sonnet-5'); part of the composite PK. */
  @PrimaryColumn({ type: 'text' })
  model!: string;

  @Column({ type: 'uuid' })
  org_id!: string;

  @Column({ type: 'uuid' })
  job_id!: string;

  /** SDK per-model breakdown: fresh input (cache-EXCLUSIVE) + separate cache read/write. */
  @Column({ type: 'bigint', default: 0, transformer: numberColumn })
  input_tokens!: number;

  @Column({ type: 'bigint', default: 0, transformer: numberColumn })
  output_tokens!: number;

  @Column({ type: 'bigint', default: 0, transformer: numberColumn })
  cache_read_tokens!: number;

  @Column({ type: 'bigint', default: 0, transformer: numberColumn })
  cache_write_tokens!: number;

  /** SDK-computed cost for this model's share of the turn (`ModelUsage.costUSD`). */
  @Column({ type: 'numeric', default: 0, transformer: numberColumn })
  cost_usd!: number;

  @Column({ type: 'int', default: 0 })
  web_search_requests!: number;
}
