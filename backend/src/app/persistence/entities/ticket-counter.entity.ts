import { Column, Entity, JoinColumn, OneToOne, PrimaryColumn } from 'typeorm';
import { RepoEntity } from './repo.entity';

/**
 * Per-repo monotonic allocator for the human-friendly ticket `number` (#14). One row per repo; the
 * `next` value is advanced atomically on each create via
 * `INSERT … ON CONFLICT (repo_id) DO UPDATE SET next = ticket_counters.next + 1 RETURNING next`
 * (a `SELECT max()+1` would race — aggregate reads aren't row-locked). The `tickets` unique
 * `(repo_id, number)` constraint is the backstop.
 *
 * No timestamps — this is pure bookkeeping, not a domain row.
 */
@Entity({ name: 'ticket_counters' })
export class TicketCounterEntity {
  /** The repo this counter belongs to (PK, FK → repos.id). */
  @PrimaryColumn({ type: 'uuid' })
  repo_id!: string;

  @OneToOne(() => RepoEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'repo_id' })
  repo?: RepoEntity;

  /** The last number allocated for this repo (the most recent ticket's `number`). */
  @Column({ type: 'int', default: 0 })
  next!: number;
}
