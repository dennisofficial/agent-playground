import { TimestampedEntity } from '@workspace/shared/schemas';
import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { JobEntity } from './job.entity';
import { numberColumn } from './numeric.transformer';

@Entity({ name: 'turn_stats' })
@Index(['job_id'])
@Index(['org_id'])
@Index(['thread_id'])
export class TurnStatsEntity extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', nullable: true })
  turn_id!: string | null;

  @Column({ type: 'uuid' })
  org_id!: string;

  @Column({ type: 'uuid' })
  job_id!: string;

  @ManyToOne(() => JobEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'job_id' })
  job?: JobEntity;

  @Column({ type: 'uuid', nullable: true })
  thread_id!: string | null;

  @Column({ type: 'uuid', nullable: true })
  step_id!: string | null;

  @Column({ type: 'text' })
  lane!: string;

  @Column({ type: 'text' })
  kind!: string;

  @Column({ type: 'text' })
  engine!: string;

  @Column({ type: 'uuid', nullable: true })
  credential_id!: string | null;

  @Column({ type: 'text', nullable: true })
  engine_git_sha!: string | null;

  @Column({ type: 'text', nullable: true })
  model!: string | null;

  @Column({ type: 'bigint', default: 0, transformer: numberColumn })
  input_tokens!: number;

  @Column({ type: 'bigint', default: 0, transformer: numberColumn })
  output_tokens!: number;

  @Column({ type: 'bigint', default: 0, transformer: numberColumn })
  cache_read_tokens!: number;

  @Column({ type: 'bigint', default: 0, transformer: numberColumn })
  cache_write_tokens!: number;

  @Column({ type: 'numeric', nullable: true, transformer: numberColumn })
  cost_usd!: number | null;

  @Column({ type: 'int', nullable: true })
  context_tokens!: number | null;

  @Column({ type: 'int', nullable: true })
  context_limit!: number | null;

  @Column({ type: 'jsonb', nullable: true })
  tags!: Record<string, unknown> | null;

  @Column({ type: 'jsonb', nullable: true })
  raw!: Record<string, unknown> | null;
}
