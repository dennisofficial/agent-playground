import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { TimestampedEntity } from '@workspace/shared/schemas';

/**
 * One message in a thread's append-only log. Many histories = ONE `atlas_messages` table partitioned
 * by `thread_id` (the index below). Threads are isolated; coherence across them is shared memory, not
 * shared transcript.
 */
@Entity({ name: 'atlas_messages' })
@Index(['thread_id', 'created_at'])
export class AtlasMessage extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The thread this message belongs to — the partition key (FK → atlas_threads). */
  @Column({ type: 'uuid' })
  thread_id!: string;

  /** Display name ("Dennis", "Atlas"). */
  @Column({ type: 'text' })
  author!: string;

  /** Scope id ("dennis", "atlas"). */
  @Column({ type: 'text' })
  author_id!: string;

  /** Set when Atlas (the brain) authored it. */
  @Column({ type: 'text', nullable: true })
  author_bot_id!: string | null;

  @Column({ type: 'text' })
  text!: string;
}
