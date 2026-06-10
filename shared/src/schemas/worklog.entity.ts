import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Completed-work record (episodic): what a bot finished and when — the "what got done" a standup asks for.
 * Append-only. Project-scoped. Single `completed_at` timestamp (no created/updated pair).
 */
@Entity({ name: 'worklog' })
@Index(['project', 'owner_bot', 'completed_at'])
export class Worklog {
  @PrimaryGeneratedColumn()
  id!: number;

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
