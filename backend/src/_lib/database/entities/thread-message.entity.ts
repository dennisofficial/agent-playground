import { TimestampedEntity } from '@lib/database/base.entity';
import { EThreadMessageKind, EThreadMessageSource } from '@workspace/shared';
import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Repository,
} from 'typeorm';
import { Job } from './job.entity';
import { Organization } from './organization.entity';
import { Subagent } from './subagent.entity';
import { Thread } from './thread.entity';

@Entity({ name: 'thread_messages' })
@Index(['jobId', 'createdAt'])
@Index(['threadId', 'createdAt'])
@Index(['subagentId'])
@Index(['orgId'])
export class ThreadMessage extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  jobId!: string;

  @ManyToOne(() => Job, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'job_id' })
  job?: Job;

  @Column({ type: 'uuid' })
  threadId!: string;

  @ManyToOne(() => Thread, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'thread_id' })
  thread?: Thread;

  @Column({ type: 'uuid' })
  orgId!: string;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'org_id' })
  org?: Organization;

  /** Set when this block belongs to a spawned subagent's window; null for a block owned directly by the
   *  thread. */
  @Column({ type: 'uuid', nullable: true })
  subagentId!: string | null;

  @ManyToOne(() => Subagent, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'subagent_id' })
  subagent?: Subagent | null;

  @Column({ type: 'enum', enum: EThreadMessageSource })
  source!: EThreadMessageSource;

  @Column({ type: 'text' })
  authorId!: string;

  /** Display name of the author. */
  @Column({ type: 'text' })
  author!: string;

  @Column({ type: 'text' })
  text!: string;

  @Column({ type: 'enum', enum: EThreadMessageKind, default: EThreadMessageKind.CHAT })
  kind!: EThreadMessageKind;

  /** Structured UI card payload (approval cards, diffs, etc.), or null for a plain block. */
  @Column({ type: 'jsonb', nullable: true })
  card!: Record<string, unknown> | null;

  /** Free per-message metadata (tool-call details, failure classification, …), or null. */
  @Column({ type: 'jsonb', nullable: true })
  meta!: Record<string, unknown> | null;

  /** Effective render-order override; null for the common case (falls back to `createdAt`). */
  @Column({ type: 'timestamptz', nullable: true })
  orderAt!: Date | null;
}

export class ThreadMessageRepo extends Repository<ThreadMessage> {}
