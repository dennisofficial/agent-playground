import { TimestampedEntity } from '@lib/database/base.entity';
import type { AtlasClaims } from '@lib/rls/atlas-claims';
import { Expose, Rls } from '@workspace/nestjs-rls';
import { Realtime } from '@workspace/pg-realtime/nest-realtime';
import {
  EMessageAudience,
  EThreadMessageSource,
  EThreadOutputType,
  THREAD_MESSAGE_TYPE_VALUES,
  type EThreadMessageType,
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
import { Subagent } from './subagent.entity';
import { Thread } from './thread.entity';

@Entity({ name: 'thread_messages' })
@Index(['jobId', 'createdAt'])
@Index(['threadId', 'createdAt'])
@Index(['subagentId'])
@Index(['orgId'])
@Rls<ThreadMessage, AtlasClaims>((c) => ({ orgId: { $in: c.orgIds } }))
@Realtime()
export class ThreadMessage extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  @Expose()
  id!: string;

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

  @Column({ type: 'uuid' })
  @Expose() // kept for the guard scope
  orgId!: string;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'org_id' })
  org?: Organization;

  /** Set when this block belongs to a spawned subagent's window; null for a block owned directly by the
   *  thread. */
  @Column({ type: 'uuid', nullable: true })
  @Expose()
  subagentId!: string | null;

  @ManyToOne(() => Subagent, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'subagent_id' })
  subagent?: Subagent | null;

  @Column({ type: 'enum', enum: EThreadMessageSource })
  @Expose()
  source!: EThreadMessageSource;

  /** Who may see this message — orthogonal to `source`. `operator`/`atlas` are always shared; `system`
   *  messages choose (operator-only vs shared → whether it enters Atlas's context). Not currently
   *  streamed — the old SSE path never exposed it either. */
  @Column({ type: 'enum', enum: EMessageAudience, default: EMessageAudience.SHARED })
  audience!: EMessageAudience;

  /** Not currently streamed — the old SSE path never exposed it either. */
  @Column({ type: 'text' })
  authorId!: string;

  @Column({ type: 'text' })
  @Expose()
  text!: string;

  /** The authoritative message type (intake type OR output type) — the single source the render layer
   *  switches over. Subsumes the old coarse `kind`. */
  @Column({
    type: 'enum',
    enum: THREAD_MESSAGE_TYPE_VALUES,
    default: EThreadOutputType.CHAT,
  })
  @Expose()
  type!: EThreadMessageType;

  /** Structured UI card payload (approval cards, diffs, etc.), or null for a plain block. */
  @Column({ type: 'jsonb', nullable: true })
  @Expose()
  card!: Record<string, unknown> | null;

  /** Free per-message metadata (tool-call details, failure classification, …), or null. */
  @Column({ type: 'jsonb', nullable: true })
  @Expose()
  meta!: Record<string, unknown> | null;

  /** Effective render-order override; null for the common case (falls back to `createdAt`). */
  @Column({ type: 'timestamptz', nullable: true })
  @Expose()
  orderAt!: Date | null;

  // Redeclared (no @Column — inherited from TimestampedEntity) purely to attach @Expose, aliased
  // to `postedAt` to match the prior mapRow. `updatedAt` is not streamed (never was).
  @Expose('postedAt')
  declare createdAt: Date;
}

export class ThreadMessageRepo extends Repository<ThreadMessage> {}
