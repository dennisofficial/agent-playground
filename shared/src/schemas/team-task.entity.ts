import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { TimestampedEntity } from './classes/base.entity';

/**
 * TEAM BOARD task: a deliberate, shared work item — the team's coordination surface, distinct from
 * the per-employee reminder plate (`tasks`). The lead creates/assigns these when dispatching;
 * teammates claim unassigned ones. `blocked` is DERIVED from `depends_on` (an open dependency makes
 * a task unclaimable), never stored — completing a task must stay a single-row UPDATE.
 * No norm-dedup index: board entries are created intentionally by name, not auto-captured, and a
 * recurring title across time is legitimate.
 */
@Entity({ name: 'team_tasks' })
@Index(['team_id', 'project', 'status'])
@Index(['team_id', 'assignee', 'status'])
export class TeamTask extends TimestampedEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  /** The tenant (Slack team id) this board belongs to. */
  @Column({ type: 'text' })
  team_id!: string;

  @Column({ type: 'text' })
  project!: string;

  @Column({ type: 'text' })
  title!: string;

  @Column({ type: 'text', default: '' })
  description!: string;

  // open | planning | awaiting_approval | approved | executing | self_review | in_review | done
  @Column({ type: 'text', default: 'open' })
  status!: string;

  /** Roster bot id responsible; NULL = unassigned, up for grabs. */
  @Column({ type: 'text', nullable: true })
  assignee!: string | null;

  @Column({ type: 'text' })
  created_by!: string;

  /** Same-team task ids this one waits on; claimable only once all are done. */
  @Column('int', { array: true, default: () => "'{}'" })
  depends_on!: number[];
}
