import { TimestampedEntity } from '@workspace/shared/schemas';
import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { JobEntity } from './job.entity';

@Entity({ name: 'active_turns' })
@Index(['status'])
@Index(['job_id'])
@Index('ux_active_turns_one_running_brain_per_job', ['job_id'], {
  unique: true,
  where: `"kind" = 'brain' AND "status" = 'running'`,
})
export class ActiveTurnEntity extends TimestampedEntity {
  @PrimaryColumn({ type: 'uuid' })
  turn_id!: string;

  @Column({ type: 'uuid' })
  job_id!: string;

  @ManyToOne(() => JobEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'job_id' })
  thread?: JobEntity;

  @Column({ type: 'uuid' })
  org_id!: string;

  @Column({ type: 'text' })
  channel!: string;

  @Column({ type: 'text', default: 'main' })
  lane!: string;

  @Column({ type: 'text' })
  kind!: 'brain' | 'step' | 'review' | 'gate' | 'autofix' | 'compaction' | 'rotation';

  @Column({ type: 'text', nullable: true })
  container_id!: string | null;

  @Column({ type: 'text', default: 'running' })
  status!: 'running' | 'done' | 'failed';

  @Column({ type: 'boolean', default: false })
  steerable!: boolean;

  @Column({ type: 'text', default: '0-0' })
  events_last_id!: string;

  @Column({ type: 'timestamptz', nullable: true })
  last_heartbeat_at!: Date | null;

  @Column({ type: 'jsonb', default: JSON.stringify({}) })
  ctx!: Record<string, unknown>;
}
