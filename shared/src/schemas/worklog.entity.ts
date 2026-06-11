import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Completed-work record (episodic): what a bot finished and when — the "what got done" a standup asks for.
 * Append-only. Project-scoped. Single `completed_at` timestamp (no created/updated pair).
 */
@Entity({ name: 'worklog' })
@Index(['team_id', 'project', 'owner_bot', 'completed_at'])
export class Worklog {
  @PrimaryGeneratedColumn()
  id!: number;

  /** The tenant (Slack team id) this work belongs to. */
  @Column({ type: 'text' })
  team_id!: string;

  @Column({ type: 'text' })
  owner_bot!: string;

  @Column({ type: 'text' })
  project!: string;

  @Column({ type: 'text' })
  task!: string;

  @Column({ type: 'text' })
  summary!: string;

  @Column({ type: 'timestamptz' })
  completed_at!: Date;
}
