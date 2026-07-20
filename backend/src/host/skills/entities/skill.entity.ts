import { TimestampedEntity } from '@lib/database/base.entity';
import { Column, Entity, Index, PrimaryGeneratedColumn, Repository } from 'typeorm';

/**
 * A skill mounted into an org's job sandboxes for the agent to use. `repoId` null → org-tier (all repos);
 * set → repo-tier. Minimal stub this pass; resolution/mounting logic lands with the sandbox runtime.
 */
@Entity({ name: 'skills' })
@Index(['orgId'])
export class Skill extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  orgId!: string;

  /** Null → org-tier (applies to every repo); set → scoped to one repo. */
  @Column({ type: 'uuid', nullable: true })
  repoId!: string | null;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'boolean', default: true })
  enabled!: boolean;
}

export class SkillRepo extends Repository<Skill> {}
