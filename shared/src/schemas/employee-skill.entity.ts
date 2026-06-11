import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { TimestampedEntity } from './classes/base.entity';

/**
 * A dynamically-attached employee skill (the shared-layer scaffold). Today the skills loader is a
 * no-op, but this is the table it will read: an employee's skills come from byte-stable code
 * constants PLUS any rows here. `team_id` NULL = the SHARED/global tier (every workspace's copy of
 * this employee loads it); a non-null `team_id` is a per-workspace override. "Promotion" elevates a
 * per-team skill to global by setting `team_id` to NULL. `source` is the `SkillSource` JSON
 * (git/local) the loader resolves. See `backend/docs/employee-config-db-and-promotion.md`.
 */
@Entity({ name: 'employee_skills' })
@Index(['employee_id', 'team_id'])
export class EmployeeSkill extends TimestampedEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  /** The roster employee id ('alex') this skill attaches to. */
  @Column({ type: 'text' })
  employee_id!: string;

  /** NULL = shared/global (all workspaces); non-null = a single workspace's override. */
  @Column({ type: 'text', nullable: true })
  team_id!: string | null;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text', default: '' })
  description!: string;

  /** The `SkillSource` discriminated union as JSON ({kind:'git',url,ref?,subPath?} | {kind:'local',path}). */
  @Column({ type: 'jsonb' })
  source!: Record<string, unknown>;
}
