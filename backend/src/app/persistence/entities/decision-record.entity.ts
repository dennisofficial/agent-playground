import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { TimestampedEntity } from '@workspace/shared/schemas';
import type { Decision } from '../../domain/decision-record';
import { OrganizationEntity } from './organization.entity';
import { RepoEntity } from './repo.entity';
import { JobEntity } from './job.entity';
import { UserEntity } from './user.entity';

/**
 * The locked DECISION RECORD — the upfront grill's durable output: the agreed overview, the
 * architecture/system calls (`decisions`), and the high-level track list (`thread_titles`),
 * approved ONCE. It grounds every track's just-in-time plan and the decision-class gate (a track
 * planner parks only on an always-ask class NOT already settled here). 1:many with the thread — a
 * re-propose marks the prior draft `superseded` and writes a new one (the proposal audit trail).
 */
@Entity({ name: 'decision_records' })
@Index(['org_id', 'repo_id'])
@Index(['job_id'])
export class DecisionRecordEntity extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The tenant (FK → organizations.id). */
  @Column({ type: 'uuid' })
  org_id!: string;

  @ManyToOne(() => OrganizationEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'org_id' })
  org?: OrganizationEntity;

  /** The project this record scopes to (FK → repos.id). */
  @Column({ type: 'uuid' })
  repo_id!: string;

  @ManyToOne(() => RepoEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'repo_id' })
  repo?: RepoEntity;

  /** The thread this record was produced for (FK → threads.id). */
  @Column({ type: 'uuid' })
  job_id!: string;

  @ManyToOne(() => JobEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'job_id' })
  thread?: JobEntity;

  // 'draft' | 'approved' | 'superseded'
  @Column({ type: 'text', default: 'draft' })
  status!: string;

  /** The agreed overview — intent, stack, constraints, and how the tracks fit together. */
  @Column({ type: 'text' })
  overview!: string;

  /** The locked architecture/system calls (a `Decision[]` from the domain types). */
  @Column({ type: 'jsonb', default: [] })
  decisions!: Decision[];

  /** The high-level track briefs approved upfront — drives the thread's track rows. */
  @Column({ type: 'text', array: true, default: () => `'{}'` })
  thread_titles!: string[];

  /** Who approved it (a user id); null until approved. */
  @Column({ type: 'uuid', nullable: true })
  approved_by!: string | null;

  @ManyToOne(() => UserEntity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'approved_by' })
  approvedByUser?: UserEntity | null;

  @Column({ type: 'timestamptz', nullable: true })
  approved_at!: Date | null;
}
