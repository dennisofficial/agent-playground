import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { TimestampedEntity } from '@workspace/shared/schemas';
import { ThreadEntity } from './thread.entity';

/**
 * One message in a thread's append-only log. Many histories = ONE `messages` table partitioned
 * by `thread_id` (the index below). Threads are isolated; coherence across them is shared memory, not
 * shared transcript.
 */
@Entity({ name: 'messages' })
@Index(['thread_id', 'created_at'])
export class MessageEntity extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The thread this message belongs to — the partition key (FK → threads). */
  @Column({ type: 'uuid' })
  thread_id!: string;

  @ManyToOne(() => ThreadEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'thread_id' })
  thread?: ThreadEntity;

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

  /** Surface ordering handle (the synthetic ts the surface minted); also the SSE/edit key. */
  @Column({ type: 'text', nullable: true })
  ts!: string | null;

  /** What this row is: 'chat' (conversational, fed to the grill) | 'card' | 'build_event'. */
  @Column({ type: 'text', default: 'chat' })
  kind!: string;

  /** Approval/verdict card payload (when kind='card'); null otherwise. */
  @Column({ type: 'jsonb', nullable: true })
  card!: Record<string, unknown> | null;

  /** Opaque metadata (e.g. build-phase event context) when kind='build_event'; null otherwise. */
  @Column({ type: 'jsonb', nullable: true })
  meta!: Record<string, unknown> | null;
}
