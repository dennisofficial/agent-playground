import { TimestampedEntity } from '@workspace/shared/schemas';
import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { JobEntity } from './job.entity';
import { OrganizationEntity } from './organization.entity';
import { UserEntity } from './user.entity';

/**
 * One uploaded-on-add draft attachment — a draft can carry many. The bytes live on a HOST dir keyed by
 * `(org_id, job_id, user_id)` (see `SandboxProvider.draftUploadsDirHost`), deliberately OUTSIDE the job's
 * `/context` mount so they stay invisible to the sandbox/brain until a later thread promotes the file into
 * `/context/uploads/` on send. This row is the durable record of what's staged, not the bytes themselves.
 */
@Entity({ name: 'composer_draft_attachments' })
@Index(['job_id', 'user_id'])
export class ComposerDraftAttachmentEntity extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The tenant (org id) — denormalized for org-scoped queries (FK → organizations.id). */
  @Column({ type: 'uuid' })
  org_id!: string;

  @ManyToOne(() => OrganizationEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'org_id' })
  org?: OrganizationEntity;

  /** The job the owning draft is composing a message for (FK → jobs.id). */
  @Column({ type: 'uuid' })
  job_id!: string;

  @ManyToOne(() => JobEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'job_id' })
  job?: JobEntity;

  /** The operator who owns the draft (FK → users.id). */
  @Column({ type: 'uuid' })
  user_id!: string;

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user?: UserEntity;

  /** The original filename, for display. */
  @Column({ type: 'text' })
  filename!: string;

  /** The sanitized on-disk filename under `draftUploadsDirHost`. */
  @Column({ type: 'text' })
  stored_name!: string;

  /** 'image' | 'file'. Stays a `text` column at the DB level (repo convention — no Postgres enums). */
  @Column({ type: 'text' })
  kind!: 'image' | 'file';

  /** Byte size of the staged file. */
  @Column({ type: 'int' })
  size!: number;
}
