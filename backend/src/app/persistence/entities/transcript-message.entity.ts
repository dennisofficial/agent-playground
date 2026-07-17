import { TimestampedEntity } from '@workspace/shared/schemas';
import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { JobEntity } from './job.entity';
import { SubagentEntity } from './subagent.entity';
import { ThreadEntity } from './thread.entity';

@Entity({ name: 'transcript_messages' })
@Index(['job_id', 'created_at'])
@Index(['thread_id', 'created_at'])
@Index(['subagent_id'])
@Index(['stimulus_id'])
@Index('ux_transcript_messages_idem_key', ['idem_key'], {
  unique: true,
  where: `"idem_key" IS NOT NULL`,
})
export class TranscriptMessageEntity extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  job_id!: string;

  @ManyToOne(() => JobEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'job_id' })
  thread?: JobEntity;

  @Column({ type: 'uuid' })
  thread_id!: string;

  @ManyToOne(() => ThreadEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'thread_id' })
  threadRef?: ThreadEntity;

  @Column({ type: 'uuid', nullable: true })
  subagent_id!: string | null;

  @ManyToOne(() => SubagentEntity, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'subagent_id' })
  subagent?: SubagentEntity | null;

  @Column({ type: 'text' })
  author!: string;

  @Column({ type: 'text' })
  author_id!: string;

  @Column({ type: 'text', nullable: true })
  author_bot_id!: string | null;

  @Column({ type: 'text' })
  text!: string;

  @Column({ type: 'text', nullable: true })
  ts!: string | null;

  @Column({ type: 'text', default: 'chat' })
  kind!: string;

  @Column({ type: 'jsonb', nullable: true })
  card!: Record<string, unknown> | null;

  @Column({ type: 'jsonb', nullable: true })
  meta!: Record<string, unknown> | null;

  @Column({ type: 'text', nullable: true })
  idem_key!: string | null;

  @Column({ type: 'text', nullable: true })
  engine_git_sha!: string | null;

  @Column({ type: 'uuid', nullable: true })
  stimulus_id!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  delivered_at!: Date | null;
}
