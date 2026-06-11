import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { TimestampedEntity } from './classes/base.entity';

/**
 * Per-employee REMINDER (the "plate"): a commitment made in passing that a long work session would
 * otherwise drop. Each reminder sits on exactly one employee's plate (`owner`). Project-scoped.
 * Open-dedup is per (project, owner, norm) — enforced by a unique partial index on open rows.
 */
@Entity({ name: 'tasks' })
@Index(['team_id', 'project', 'status', 'owner'])
@Index(['team_id', 'project', 'owner', 'norm'], {
  unique: true,
  where: "status = 'open'",
})
export class Task extends TimestampedEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  /** The tenant (Slack team id) this reminder belongs to. */
  @Column({ type: 'text' })
  team_id!: string;

  @Column({ type: 'text' })
  project!: string;

  @Column({ type: 'text' })
  description!: string;

  // Normalized description (lowercased, whitespace-collapsed) — the dedup key.
  @Column({ type: 'text' })
  norm!: string;

  @Column({ type: 'text', default: '' })
  owner!: string;

  // Legacy/compat column (superseded by owner); kept for back-compat reads.
  @Column({ type: 'text', nullable: true })
  assignee!: string | null;

  @Column({ type: 'text', nullable: true })
  created_by!: string | null;

  // open | done | dropped
  @Column({ type: 'text', default: 'open' })
  status!: string;

  @Column({ type: 'text', nullable: true })
  source!: string | null;
}
