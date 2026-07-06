import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique } from 'typeorm';
import { TimestampedEntity } from '@workspace/shared/schemas';
import { OrganizationEntity } from './organization.entity';
import { ThreadEntity } from './thread.entity';
import { JobEntity } from './job.entity';

/**
 * A BUILD LEG — one engine session in a build thread's life. A thread's build work used to be 1:1 with a
 * single Claude Code session; with context-rot Leg rotation it spans MANY sequential Legs, each seeded from
 * the previous one's structured handoff. This table is the durable read model behind the "Leg as a
 * first-class, navigable unit" UI (Leg rows under the thread fold + the handoff pill between them).
 *
 * It is a PROJECTION, not the source of truth for resume: the live resume handle remains `steps.session_id`
 * on the thread's anchor step (mirrored here as the current Leg's `session_id`). Rotation opens a new row
 * (ordinal+1) and closes the prior one with its `handoff_md`.
 */
@Entity({ name: 'build_legs' })
@Index(['thread_id'])
@Index(['job_id'])
@Unique(['thread_id', 'ordinal'])
export class BuildLegEntity extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The tenant (org id) — denormalized for org-scoped queries (FK → organizations.id). */
  @Column({ type: 'uuid' })
  org_id!: string;

  @ManyToOne(() => OrganizationEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'org_id' })
  org?: OrganizationEntity;

  /** The owning job/container (denormalized for job-scoped reads; FK → jobs.id). */
  @Column({ type: 'uuid' })
  job_id!: string;

  @ManyToOne(() => JobEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'job_id' })
  job?: JobEntity;

  /** The owning build thread/lane (FK → threads.id). */
  @Column({ type: 'uuid' })
  thread_id!: string;

  @ManyToOne(() => ThreadEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'thread_id' })
  thread?: ThreadEntity;

  /** 1..N — the Leg's position in the thread. Matches the anchor step's `leg_ordinal` while this Leg is live. */
  @Column({ type: 'int' })
  ordinal!: number;

  /** The engine session id this Leg ran inside; mirrors `steps.session_id` while the Leg is live. */
  @Column({ type: 'text', nullable: true })
  session_id!: string | null;

  /** 'active' (current live Leg) | 'rotated' (handed off to the next Leg) | 'closed' (thread finished on it). */
  @Column({ type: 'text', default: 'active' })
  status!: string;

  /** The structured handoff this Leg authored on rotation (null while active / for the final Leg). */
  @Column({ type: 'text', nullable: true })
  handoff_md!: string | null;

  /** The peak main-agent context occupancy observed on this Leg — the number that tripped its rotation. */
  @Column({ type: 'int', nullable: true })
  context_tokens_peak!: number | null;

  /** When the Leg was rotated/closed (null while active). Start time is the base `created_at`. */
  @Column({ type: 'timestamptz', nullable: true })
  ended_at!: Date | null;
}
