import { TimestampedEntity } from '@lib/database/base.entity';
import type { AtlasClaims } from '@lib/rls/atlas-claims';
import { Rls } from '@workspace/nestjs-rls';
import { EInboundMessageStatus, EInboundPriority, EThreadMessageSource } from '@workspace/shared';
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
import { Thread } from './thread.entity';

@Entity({ name: 'inbound_messages' })
@Index(['jobId', 'status'])
@Index(['orgId'])
@Rls<InboundMessage, AtlasClaims>((c) => ({ orgId: { $in: c.orgIds } }))
export class InboundMessage extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  orgId!: string;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'org_id' })
  org?: Organization;

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

  @Column({ type: 'text' })
  authorId!: string;

  @Column({ type: 'enum', enum: EThreadMessageSource })
  source!: EThreadMessageSource;

  @Column({ type: 'text' })
  text!: string;

  /** Structured card-reply / injected payload, or null for a plain operator message. */
  @Column({ type: 'jsonb', nullable: true })
  payload!: Record<string, unknown> | null;

  @Column({ type: 'enum', enum: EInboundMessageStatus, default: EInboundMessageStatus.PENDING })
  status!: EInboundMessageStatus;

  @Column({ type: 'enum', enum: EInboundPriority, default: EInboundPriority.NOW })
  priority!: EInboundPriority;

  /** Stamped when the row transitions to `DELIVERED` (the engine acknowledged the handoff). */
  @Column({ type: 'timestamptz', nullable: true })
  deliveredAt!: Date | null;
}

export class InboundMessageRepo extends Repository<InboundMessage> {}
