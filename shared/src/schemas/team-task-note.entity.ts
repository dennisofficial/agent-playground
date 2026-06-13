import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * An append-only note on a TEAM BOARD task — the lightweight-Jira comment trail. Out-of-scope
 * discoveries, research write-ups (long markdown is fine), and approval verdicts get parked here:
 * durable on the ticket, unlike chat scrollback. Never updated, never deleted — single timestamp
 * (the base.entity.ts comment anticipates exactly this shape).
 */
@Entity({ name: 'team_task_notes' })
@Index(['team_id', 'task_id', 'created_at'])
export class TeamTaskNote {
  @PrimaryGeneratedColumn()
  id!: number;

  /** The tenant (Slack team id) this note's board belongs to. */
  @Column({ type: 'text' })
  team_id!: string;

  /** The team_tasks.id this note is on (no FK — house style is FK-less raw SQL). */
  @Column({ type: 'int' })
  task_id!: number;

  /** Who wrote it — a roster bot id ('nora') or a human author id ('dennis'). */
  @Column({ type: 'text' })
  author!: string;

  /** Markdown body. */
  @Column({ type: 'text' })
  body!: string;

  @CreateDateColumn({ type: 'timestamptz', update: false })
  created_at!: Date;
}
