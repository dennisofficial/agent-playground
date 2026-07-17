import { EOrgStatus } from '@workspace/shared';
import { Column, Entity, PrimaryGeneratedColumn, Repository } from 'typeorm';
import { TimestampedEntity } from '../../../_lib/database/base.entity';

@Entity({ name: 'organizations' })
export class Organization extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'enum', enum: EOrgStatus, default: EOrgStatus.ONBOARDING })
  status!: EOrgStatus;

  // Org-level defaults applied when a job is created; each is independently overridable per job.
  @Column({ type: 'boolean', default: false })
  defaultAutoApprove!: boolean;

  @Column({ type: 'boolean', default: false })
  defaultAutoShip!: boolean;

  @Column({ type: 'boolean', default: false })
  defaultAutoMerge!: boolean;
}

/** Injectable DI token / typed alias for the Organization repository. */
export class OrganizationRepo extends Repository<Organization> {}
