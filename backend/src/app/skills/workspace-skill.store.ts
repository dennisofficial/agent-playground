import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DB_CONNECTION } from '../persistence/database.module';
import {
  WorkspaceSkillEntity,
  type McpSurface,
  type SkillProvenance,
  type SkillUpdatePolicy,
} from '../persistence/entities';

export const ORG_SCOPE = '*';

export interface SkillInput {
  description: string;
  provenance?: SkillProvenance;
  source_url?: string | null;
  source_ref?: string | null;
  source_subpath?: string | null;
  installed_sha?: string | null;
  update_policy?: SkillUpdatePolicy | null;
  forked_from?: string | null;
  surfaces?: McpSurface[];
  reviewForTypes?: string[];
  reviewForGlobs?: string[];
  enabled?: boolean;
}

export interface SkillView {
  scope: 'org' | string;
  name: string;
  description: string;
  provenance: SkillProvenance;
  source_url: string | null;
  source_ref: string | null;
  source_subpath: string | null;
  installed_sha: string | null;
  update_policy: SkillUpdatePolicy | null;
  forked_from: string | null;
  surfaces: McpSurface[];
  reviewForTypes: string[];
  reviewForGlobs: string[];
  enabled: boolean;
  update_available: boolean;
}

@Injectable()
export class WorkspaceSkillStore {
  private readonly logger = new Logger(WorkspaceSkillStore.name);

  constructor(
    @InjectRepository(WorkspaceSkillEntity, DB_CONNECTION)
    private readonly skills: Repository<WorkspaceSkillEntity>,
  ) {}

  static toDbScope(scope: string): string {
    return scope === 'org' ? ORG_SCOPE : scope;
  }
  static fromDbScope(scope: string): 'org' | string {
    return scope === ORG_SCOPE ? 'org' : scope;
  }


  async list(orgId: string): Promise<SkillView[]> {
    const rows = await this.skills.find({ where: { org_id: orgId } });
    return rows.map((r) => this.view(r));
  }

  async get(orgId: string, dbScope: string, name: string): Promise<SkillView | null> {
    const row = await this.skills.findOne({
      where: { org_id: orgId, scope: dbScope, name },
    });
    return row ? this.view(row) : null;
  }

  private view(r: WorkspaceSkillEntity): SkillView {
    return {
      scope: WorkspaceSkillStore.fromDbScope(r.scope),
      name: r.name,
      description: r.description,
      provenance: r.provenance,
      source_url: r.source_url,
      source_ref: r.source_ref,
      source_subpath: r.source_subpath,
      installed_sha: r.installed_sha,
      update_policy: r.update_policy,
      forked_from: r.forked_from,
      surfaces: r.surfaces,
      reviewForTypes: Array.isArray(r.review_for_types) ? r.review_for_types : [],
      reviewForGlobs: Array.isArray(r.review_for_globs) ? r.review_for_globs : [],
      enabled: r.enabled,
      update_available: r.update_available,
    };
  }


  async write(orgId: string, dbScope: string, name: string, input: SkillInput): Promise<void> {
    const row =
      (await this.skills.findOne({
        where: { org_id: orgId, scope: dbScope, name },
      })) ?? this.skills.create({ org_id: orgId, scope: dbScope, name });
    row.description = input.description;
    row.provenance = input.provenance ?? row.provenance ?? 'custom';
    row.source_url = input.source_url ?? null;
    row.source_ref = input.source_ref ?? null;
    row.source_subpath = input.source_subpath ?? null;
    row.installed_sha = input.installed_sha ?? null;
    row.update_policy = input.update_policy ?? null;
    row.forked_from = input.forked_from ?? null;
    row.surfaces = input.surfaces && input.surfaces.length > 0 ? input.surfaces : ['build'];
    row.review_for_types = input.reviewForTypes ?? [];
    row.review_for_globs = input.reviewForGlobs ?? [];
    row.enabled = input.enabled ?? true;
    await this.skills.save(row);
    this.logger.log(`wrote skill org=${orgId} scope=${dbScope} name=${name}`);
  }

  async delete(orgId: string, dbScope: string, name: string): Promise<void> {
    await this.skills.delete({ org_id: orgId, scope: dbScope, name });
    this.logger.log(`deleted skill org=${orgId} scope=${dbScope} name=${name}`);
  }


  async rowsForTurn(orgId: string, repoId: string): Promise<WorkspaceSkillEntity[]> {
    return this.skills.find({
      where: [
        { org_id: orgId, scope: ORG_SCOPE },
        { org_id: orgId, scope: repoId },
      ],
    });
  }
}
