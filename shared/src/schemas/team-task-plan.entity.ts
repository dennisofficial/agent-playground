import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { TimestampedEntity } from './classes/base.entity';

/**
 * A plan attached to a TEAM BOARD task, PER EMPLOYEE — the durable artifact of a planning session
 * (sessions are in-memory; the ticket carries the plan across restarts and is the handoff to the
 * execute session). One ticket can hold several employees' plans; the unique (team, task, employee)
 * key is the latest-wins upsert anchor. `lead_status` records the team lead's first-pass review:
 * re-attaching a revised plan resets it to 'pending' — a changed plan needs the lead again.
 */
@Entity({ name: 'team_task_plans' })
@Index(['team_id', 'task_id', 'employee'], { unique: true })
export class TeamTaskPlan extends TimestampedEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  /** The tenant (Slack team id) this plan's board belongs to. */
  @Column({ type: 'text' })
  team_id!: string;

  /** The team_tasks.id this plan belongs to (no FK — house style is FK-less raw SQL). */
  @Column({ type: 'int' })
  task_id!: number;

  /** Roster bot id of the plan's author ('alex'). */
  @Column({ type: 'text' })
  employee!: string;

  /** The full plan, markdown, including its planning Q&A appendix. */
  @Column({ type: 'text' })
  plan_md!: string;

  // 'pending' | 'approved' — the team lead's review verdict on THIS version of the plan.
  @Column({ type: 'text', default: 'pending' })
  lead_status!: string;

  /** Provenance: the (in-memory) session id that produced this plan — may dangle after restart. */
  @Column({ type: 'text', nullable: true })
  session_id!: string | null;
}
