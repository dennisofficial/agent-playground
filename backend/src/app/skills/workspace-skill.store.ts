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

/** The org-wide scope sentinel (mirrors `McpServerStore.ORG_SCOPE`); a non-`*` scope is a repo id. */
export const ORG_SCOPE = '*';

/**
 * The registry metadata a `PUT` writes (replaces the row). There is no file-content field here — the
 * skill's actual `SKILL.md`/support files live on the host store (see `skill-store-paths.ts`) and are
 * written by the installer/custom-authoring path (not this store), which owns `provenance`/`source_*`/
 * `installed_sha`. This is the metadata-only upsert: toggling `enabled`/`surfaces` on an existing skill,
 * or registering a row whose files were placed on disk out of band.
 */
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
  /** Applicability for the framework-conformance review lens — see `WorkspaceSkillEntity.review_for_types`. */
  reviewForTypes?: string[];
  /** Applicability for the framework-conformance review lens — see `WorkspaceSkillEntity.review_for_globs`. */
  reviewForGlobs?: string[];
  enabled?: boolean;
}

/** A skill as returned to a client (no secrets exist on a skill — it's registry metadata, not content). */
export interface SkillView {
  /** 'org' for an org-wide skill, otherwise the repo id. */
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
  enabled: boolean;
  /** Set by `SkillUpdaterService` for a `pinned`/`manual` git skill whose remote has moved past
   *  `installed_sha` — the console's "update available" badge. Always false for non-git skills. */
  update_available: boolean;
}

/**
 * The read/write path for the skills REGISTRY (metadata only — see `SkillInput`). Mirrors
 * {@link McpServerStore}'s shape (composite (org_id, scope, name) PK, `'org'` ⇄ `'*'` scope alias,
 * `rowsForTurn` for the resolver) MINUS the encryption — a skill has no secrets.
 */
@Injectable()
export class WorkspaceSkillStore {
  private readonly logger = new Logger(WorkspaceSkillStore.name);

  constructor(
    @InjectRepository(WorkspaceSkillEntity, DB_CONNECTION)
    private readonly skills: Repository<WorkspaceSkillEntity>,
  ) {}

  /** URL-facing `'org'` ⇄ DB `'*'`; any other value is a repo id passed through unchanged. */
  static toDbScope(scope: string): string {
    return scope === 'org' ? ORG_SCOPE : scope;
  }
  static fromDbScope(scope: string): 'org' | string {
    return scope === ORG_SCOPE ? 'org' : scope;
  }

  // ── reads ──────────────────────────────────────────────────────────────────────────────────

  /** Every skill for an org (org-wide + all repo scopes). */
  async list(orgId: string): Promise<SkillView[]> {
    const rows = await this.skills.find({ where: { org_id: orgId } });
    return rows.map((r) => this.view(r));
  }

  /** One skill by (org, dbScope, name), or null. */
  async get(orgId: string, dbScope: string, name: string): Promise<SkillView | null> {
    const row = await this.skills.findOne({ where: { org_id: orgId, scope: dbScope, name } });
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
      enabled: r.enabled,
      update_available: r.update_available,
    };
  }

  // ── writes ─────────────────────────────────────────────────────────────────────────────────

  /** Upsert a skill's registry metadata (does NOT touch the on-disk skill dir — see `SkillInput`). */
  async write(orgId: string, dbScope: string, name: string, input: SkillInput): Promise<void> {
    const row =
      (await this.skills.findOne({ where: { org_id: orgId, scope: dbScope, name } })) ??
      this.skills.create({ org_id: orgId, scope: dbScope, name });
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

  // ── resolution helpers (used by SkillResolver + the Workspace Profile snapshot) ──────────────

  /** Raw rows for the org's `'*'` scope plus one repo scope — the input to `SkillResolver`. */
  async rowsForTurn(orgId: string, repoId: string): Promise<WorkspaceSkillEntity[]> {
    return this.skills.find({
      where: [
        { org_id: orgId, scope: ORG_SCOPE },
        { org_id: orgId, scope: repoId },
      ],
    });
  }
}
