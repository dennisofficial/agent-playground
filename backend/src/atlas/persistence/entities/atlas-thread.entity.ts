import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { TimestampedEntity } from '@workspace/shared/schemas';

/**
 * A conversation thread within a project's channel. Notifications announce in the main timeline; each
 * job's chatter lives in a thread off the announcement (main stays readable). Threads are isolated
 * for context hygiene — cross-thread coherence is shared memory only, never transcript sharing.
 * `atlas_messages` partition by `thread_id`.
 */
@Entity({ name: 'atlas_threads' })
@Index(['team_id', 'project_id'])
export class AtlasThread extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The tenant (Slack team id). */
  @Column({ type: 'text' })
  team_id!: string;

  /** The project (and thus channel) this thread lives in. */
  @Column({ type: 'text' })
  project_id!: string;

  /** What opened the thread: 'chat' (human-started) | 'event' (notification-seeded). */
  @Column({ type: 'text' })
  origin!: string;

  /** The surface-native thread coordinate (e.g. the root message ts); null until posted. */
  @Column({ type: 'text', nullable: true })
  surface_thread_ref!: string | null;

  /** Short human-readable label (the feature/notification title). */
  @Column({ type: 'text', nullable: true })
  title!: string | null;

  /**
   * The base branch the operator picked at thread creation (default = repo default). Null for
   * inbound-message-derived threads that pre-date R2 (they inherit from the project's default_branch
   * at build time, as before).
   */
  @Column({ type: 'text', nullable: true })
  base_branch!: string | null;
}
