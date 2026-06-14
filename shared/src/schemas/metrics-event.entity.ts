import type { IMetricsEventType } from '../types';
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity({ name: 'metrics_events' })
@Index(['team_id', 'project_id', 'event_type', 'occurred_at'])
@Index(['team_id', 'agent_id', 'event_type', 'occurred_at'])
@Index(['team_id', 'ticket_id', 'agent_id', 'revision_number'])
export class MetricsEvent {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'text' })
  team_id!: string;

  @Column({ type: 'text' })
  event_type!: IMetricsEventType;

  @Column({ type: 'text', nullable: true })
  ticket_id!: string | null;

  @Column({ type: 'text', nullable: true })
  agent_id!: string | null;

  @Column({ type: 'text', nullable: true })
  project_id!: string | null;

  @Column({ type: 'text', nullable: true })
  session_id!: string | null;

  @Column({ type: 'int', nullable: true })
  revision_number!: number | null;

  @Column({ type: 'int', nullable: true })
  duration_ms!: number | null;

  @Column({ type: 'int', nullable: true })
  time_to_approval_ms!: number | null;

  @Column({ type: 'text', nullable: true })
  reason!: string | null;

  @Column({ type: 'timestamptz' })
  occurred_at!: Date;

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  payload!: Record<string, unknown>;
}
