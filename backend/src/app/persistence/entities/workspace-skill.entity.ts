import { TimestampedEntity } from '@workspace/shared/schemas';
import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import type { McpSurface } from './mcp-server.entity';
import { OrganizationEntity } from './organization.entity';

@Entity({ name: 'workspace_skills' })
@Index(['org_id'])
export class WorkspaceSkillEntity extends TimestampedEntity {
  @PrimaryColumn({ type: 'uuid' })
  org_id!: string;

  @ManyToOne(() => OrganizationEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'org_id' })
  org?: OrganizationEntity;

  @PrimaryColumn({ type: 'text', default: '*' })
  scope!: string;

  @PrimaryColumn({ type: 'text' })
  name!: string;

  @Column({ type: 'text' })
  description!: string;

  @Column({ type: 'text', default: 'custom' })
  provenance!: SkillProvenance;

  @Column({ type: 'text', nullable: true })
  source_url!: string | null;

  @Column({ type: 'text', nullable: true })
  source_ref!: string | null;

  @Column({ type: 'text', nullable: true })
  source_subpath!: string | null;

  @Column({ type: 'text', nullable: true })
  installed_sha!: string | null;

  @Column({ type: 'text', nullable: true })
  update_policy!: SkillUpdatePolicy | null;

  @Column({ type: 'text', nullable: true })
  forked_from!: string | null;

  @Column({ type: 'jsonb', default: ['build'] })
  surfaces!: McpSurface[];

  @Column({ type: 'jsonb', default: [] })
  review_for_types!: string[];

  @Column({ type: 'jsonb', default: [] })
  review_for_globs!: string[];

  @Column({ type: 'boolean', default: true })
  enabled!: boolean;

  @Column({ type: 'boolean', default: false })
  update_available!: boolean;
}

export type SkillProvenance = 'git' | 'custom' | 'managed';

export type SkillUpdatePolicy = 'pinned' | 'track-ref' | 'manual';
