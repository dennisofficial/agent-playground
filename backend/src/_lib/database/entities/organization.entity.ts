import { TimestampedEntity } from '@lib/database/base.entity';
import type { AtlasClaims } from '@lib/rls/atlas-claims';
import { Rls } from '@workspace/nestjs-rls';
import { EOrgStatus } from '@workspace/shared';
import { Column, Entity, PrimaryGeneratedColumn, Repository } from 'typeorm';

@Entity({ name: 'organizations' })
// Scoped by the org's own id (the org IS the tenant).
@Rls<Organization, AtlasClaims>((c) => ({ id: { $in: c.orgIds } }))
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

export class OrganizationRepo extends Repository<Organization> {}
