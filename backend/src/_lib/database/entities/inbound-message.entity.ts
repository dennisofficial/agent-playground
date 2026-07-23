import { TimestampedEntity } from '@lib/database/base.entity';
import type { AtlasClaims } from '@lib/rls/atlas-claims';
import { Expose, Rls } from '@workspace/nestjs-rls';
import { Realtime } from '@workspace/pg-realtime/nest-realtime';
import {
  EInboundMessageStatus,
  EInboundPriority,
  EThreadMessageSource,
  type InboundMessagePayload,
} from '@workspace/shared';
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
@Realtime()
export class InboundMessage extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  @Expose()
  id!: string;

  @Column({ type: 'uuid' })
  @Expose() // kept for the guard scope
  orgId!: string;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'org_id' })
  org?: Organization;

  @Column({ type: 'uuid' })
  @Expose()
  jobId!: string;

  @ManyToOne(() => Job, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'job_id' })
  job?: Job;

  @Column({ type: 'uuid' })
  @Expose()
  threadId!: string;

  @ManyToOne(() => Thread, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'thread_id' })
  thread?: Thread;

  @Column({ type: 'text' })
  @Expose()
  authorId!: string;

  @Column({ type: 'enum', enum: EThreadMessageSource })
  @Expose()
  source!: EThreadMessageSource;

  @Column({ type: 'text' })
  @Expose()
  text!: string;

  @Column({ type: 'jsonb', nullable: true })
  @Expose()
  payload!: InboundMessagePayload | null;

  @Column({ type: 'enum', enum: EInboundMessageStatus, default: EInboundMessageStatus.PENDING })
  @Expose()
  status!: EInboundMessageStatus;

  @Column({ type: 'enum', enum: EInboundPriority, default: EInboundPriority.NOW })
  @Expose()
  priority!: EInboundPriority;

  /** Stamped when the row transitions to `DELIVERED` (the engine acknowledged the handoff). Not
   *  currently streamed — the old SSE path never exposed it either. */
  @Column({ type: 'timestamptz', nullable: true })
  deliveredAt!: Date | null;

  // Redeclared (no @Column — inherited from TimestampedEntity) purely to attach @Expose;
  // `updatedAt` is not streamed (never was).
  @Expose()
  declare createdAt: Date;
}

export class InboundMessageRepo extends Repository<InboundMessage> {}
