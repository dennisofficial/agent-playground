import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { TimestampedEntity } from './classes/base.entity';

/**
 * A plan attached to a TEAM BOARD task — the durable artifact of a planning session (sessions are
 * in-memory; the ticket carries the plan across restarts and is the handoff to the execute session).
 * ONE plan per task: the unique (team, task) key is the latest-wins upsert anchor (the `employee`
 * column records the authoring role, not part of the key). `lead_status` records the lead's
 * first-pass review: re-attaching a revised plan resets it to 'pending' — a changed plan needs the
 * lead again.
 */
@Entity({ name: 'team_task_plans' })
@Index(['team_id', 'task_id'], { unique: true })
export class TeamTaskPlan extends TimestampedEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  /** The tenant (Slack team id) this plan's board belongs to. */
  @Column({ type: 'text' })
  team_id!: string;

  /** The team_tasks.id this plan belongs to (no FK — house style is FK-less raw SQL). */
  @Column({ type: 'int' })
  task_id!: number;

  /** Roster id of the plan's authoring role ('alex') — provenance only, NOT part of the unique key. */
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

  /**
   * EXECUTION state of the task's single plan row, set during the harness-driven review pipeline
   * (distinct from the task's coarse status): 'executing' (default — coding / self-review),
   * 'reviewed' (self-review clean, mid-publish), 'complete' (the work is published + reviewed), or
   * 'blocked' (a publish conflict or failure left work needing the owner). The task flips
   * 'executing' → 'self_review' when this row reaches 'complete'.
   */
  @Column({ type: 'text', default: 'executing' })
  owner_status!: string;

  /** The execute worktree this owner's work lives in — stamped at execute-session start so the
   * integration barrier can find the shared branch / PR without re-deriving it. */
  @Column({ type: 'text', nullable: true })
  execute_worktree_id!: string | null;

  /** The shared integration branch (shared/<slug>) this owner publishes through. */
  @Column({ type: 'text', nullable: true })
  shared_branch!: string | null;

  /** The task-level PR URL, stamped by the integration barrier once the draft PR exists. */
  @Column({ type: 'text', nullable: true })
  pr_url!: string | null;
}
