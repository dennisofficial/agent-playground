import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { TimestampedEntity } from '@workspace/shared/schemas';
import type { DraftPayload } from '@shared/domain/composer-draft';
import { OrganizationEntity } from './organization.entity';
import { JobEntity } from './job.entity';
import { UserEntity } from './user.entity';

/**
 * One in-progress composer draft, at most one row per (job, user) — the operator's unsent text, staged
 * question/file/secret answers, and queued review comments, held server-side so it survives a tab close
 * or device switch. Clearing a draft on send is an UPDATE to an empty payload, never a DELETE: a WAL
 * DELETE only carries the PK, and a later thread's realtime model routes drafts by userId off the row's
 * jsonb payload, which a bare delete can't carry.
 */
@Entity({ name: 'composer_drafts' })
@Index(['job_id', 'user_id'], { unique: true })
export class ComposerDraftEntity extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The tenant (org id) — denormalized for org-scoped queries (FK → organizations.id). */
  @Column({ type: 'uuid' })
  org_id!: string;

  @ManyToOne(() => OrganizationEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'org_id' })
  org?: OrganizationEntity;

  /** The job this draft is composing a message for (FK → jobs.id). */
  @Column({ type: 'uuid' })
  job_id!: string;

  @ManyToOne(() => JobEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'job_id' })
  job?: JobEntity;

  /** The operator who owns this draft (FK → users.id). */
  @Column({ type: 'uuid' })
  user_id!: string;

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user?: UserEntity;

  /** The draft's text/staged-answers/queued-comments (see `DraftPayload`). No DB default — the service
   *  (a later thread) always writes a full payload. */
  @Column({ type: 'jsonb' })
  payload!: DraftPayload;
}
