import { TimestampedEntity } from '@workspace/shared/schemas';
import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { numberColumn } from './numeric.transformer';
import { TurnStatsEntity } from './turn-stats.entity';

@Entity({ name: 'turn_model_usage' })
@Index(['job_id'])
@Index(['org_id'])
export class TurnModelUsageEntity extends TimestampedEntity {
  @PrimaryColumn({ type: 'uuid' })
  turn_stats_id!: string;

  @ManyToOne(() => TurnStatsEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'turn_stats_id' })
  turn?: TurnStatsEntity;

  @PrimaryColumn({ type: 'text' })
  model!: string;

  @Column({ type: 'uuid' })
  org_id!: string;

  @Column({ type: 'uuid' })
  job_id!: string;

  @Column({ type: 'bigint', default: 0, transformer: numberColumn })
  input_tokens!: number;

  @Column({ type: 'bigint', default: 0, transformer: numberColumn })
  output_tokens!: number;

  @Column({ type: 'bigint', default: 0, transformer: numberColumn })
  cache_read_tokens!: number;

  @Column({ type: 'bigint', default: 0, transformer: numberColumn })
  cache_write_tokens!: number;

  @Column({ type: 'numeric', default: 0, transformer: numberColumn })
  cost_usd!: number;

  @Column({ type: 'int', default: 0 })
  web_search_requests!: number;
}
