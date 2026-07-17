import { TimestampedEntity } from '@workspace/shared/schemas';
import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { OrganizationEntity } from './organization.entity';
import { RepoEntity } from './repo.entity';

@Entity({ name: 'org_workspace_mounts' })
@Index(['org_id'])
@Index(['org_id', 'repo_id'])
export class OrgWorkspaceMountEntity extends TimestampedEntity {
  @PrimaryColumn({ type: 'uuid' })
  org_id!: string;

  @ManyToOne(() => OrganizationEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'org_id' })
  org?: OrganizationEntity;

  @PrimaryColumn({ type: 'uuid' })
  repo_id!: string;

  @ManyToOne(() => RepoEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'repo_id' })
  repo?: RepoEntity;

  @PrimaryColumn({ type: 'text' })
  path!: string;

  @Column({ type: 'text' })
  mode!: string;
}
