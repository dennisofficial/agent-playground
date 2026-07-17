import { TimestampedEntity } from '@workspace/shared/schemas';
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type ProdMaintenanceWriteStatus =
  | 'pending'
  | 'approved'
  | 'executed'
  | 'failed'
  | 'rejected'
  | 'superseded';

export type ProdMaintenanceWriteDryRun = {
  estimatedRows?: number;
  plan?: string;
  error?: string;
};

export type ProdMaintenanceWriteResult = {
  affectedRows?: number;
  error?: string;
};

@Entity({ name: 'prod_maintenance_write' })
@Index(['job_id', 'status'])
export class ProdMaintenanceWriteEntity extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  org_id!: string;

  @Column({ type: 'text' })
  repo_id!: string;

  @Column({ type: 'uuid' })
  job_id!: string;

  @Column({ type: 'text', nullable: true })
  proposed_by_session!: string | null;

  @Column({ type: 'text' })
  sql!: string;

  @Column({ type: 'text', default: 'pending' })
  status!: ProdMaintenanceWriteStatus;

  @Column({ type: 'jsonb' })
  dry_run!: ProdMaintenanceWriteDryRun;

  @Column({ type: 'uuid', nullable: true })
  approved_by!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  approved_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  executed_at!: Date | null;

  @Column({ type: 'jsonb', nullable: true })
  result!: ProdMaintenanceWriteResult | null;
}
