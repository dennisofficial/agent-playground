import type { AutoApproveMode } from '@workspace/shared';
import { Column, Entity, Index, PrimaryGeneratedColumn, Repository } from 'typeorm';
import { TimestampedEntity } from '../../../_lib/database/base.entity';

export type OrgStatus = 'onboarding' | 'active' | 'suspended';

@Entity({ name: 'organizations' })
export class Organization extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'text' })
  name!: string;

  @Index({ unique: true })
  @Column({ type: 'text' })
  slug!: string;

  @Column({ type: 'text', default: 'onboarding' })
  status!: OrgStatus;

  @Column({ type: 'text', default: 'off' })
  defaultAutoApproveMode!: AutoApproveMode;

  @Column({ type: 'boolean', default: false })
  defaultAutoMerge!: boolean;
}

/** Injectable DI token / typed alias for the Organization repository. */
export class OrganizationRepo extends Repository<Organization> {}
