import { TimestampedEntity } from '@lib/database/base.entity';
import type { AtlasClaims } from '@lib/rls/atlas-claims';
import { Expose, Rls } from '@workspace/nestjs-rls';
import { Realtime } from '@workspace/pg-realtime/nest-realtime';
import { EOrgStatus } from '@workspace/shared';
import { Column, Entity, PrimaryGeneratedColumn, Repository } from 'typeorm';

@Entity({ name: 'organizations' })
// Scoped by the org's own id (the org IS the tenant).
@Rls<Organization, AtlasClaims>((c) => ({ id: { $in: c.orgIds } }))
@Realtime()
export class Organization extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  @Expose()
  id!: string;

  @Column({ type: 'text' })
  @Expose()
  name!: string;

  @Column({ type: 'enum', enum: EOrgStatus, default: EOrgStatus.ONBOARDING })
  @Expose()
  status!: EOrgStatus;

  // Org-level defaults applied when a job is created; each is independently overridable per job.
  @Column({ type: 'boolean', default: false })
  @Expose()
  defaultAutoApprove!: boolean;

  @Column({ type: 'boolean', default: false })
  @Expose()
  defaultAutoShip!: boolean;

  @Column({ type: 'boolean', default: false })
  @Expose()
  defaultAutoMerge!: boolean;
}

export class OrganizationRepo extends Repository<Organization> {}
