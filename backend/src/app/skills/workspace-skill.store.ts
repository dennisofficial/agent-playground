import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DB_CONNECTION } from '../persistence/database.module';
import { WorkspaceSkillEntity, type McpSurface } from '../persistence/entities';

/** The org-wide scope sentinel (mirrors `McpServerStore.ORG_SCOPE`); a non-`*` scope is a repo id. */
export const ORG_SCOPE = '*';

/** The full skill definition a `PUT` writes (replaces the row). */
export interface SkillInput {
  description: string;
  body: string;
  surfaces?: McpSurface[];
  enabled?: boolean;
}

/** A skill as returned to a client (no secrets exist on a skill — the body is plain markdown). */
export interface SkillView {
  /** 'org' for an org-wide skill, otherwise the repo id. */
  scope: 'org' | string;
  name: string;
  description: string;
  body: string;
  surfaces: McpSurface[];
  enabled: boolean;
}

/**
 * The read/write path for user/brain-defined skills. Mirrors {@link McpServerStore}'s shape (composite
 * (org_id, scope, name) PK, `'org'` ⇄ `'*'` scope alias, `rowsForTurn` for the resolver) MINUS the
 * encryption — a skill is plain markdown, so there is no `secrets_enc` / cipher.
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

  /** One skill by (org, dbScope, name), or null. Includes the body (no secrets on a skill). */
  async get(orgId: string, dbScope: string, name: string): Promise<SkillView | null> {
    const row = await this.skills.findOne({ where: { org_id: orgId, scope: dbScope, name } });
    return row ? this.view(row) : null;
  }

  private view(r: WorkspaceSkillEntity): SkillView {
    return {
      scope: WorkspaceSkillStore.fromDbScope(r.scope),
      name: r.name,
      description: r.description,
      body: r.body,
      surfaces: r.surfaces,
      enabled: r.enabled,
    };
  }

  // ── writes ─────────────────────────────────────────────────────────────────────────────────

  /** Upsert a skill definition (replaces the row's content). */
  async write(orgId: string, dbScope: string, name: string, input: SkillInput): Promise<void> {
    const row =
      (await this.skills.findOne({ where: { org_id: orgId, scope: dbScope, name } })) ??
      this.skills.create({ org_id: orgId, scope: dbScope, name });
    row.description = input.description;
    row.body = input.body;
    row.surfaces = input.surfaces && input.surfaces.length > 0 ? input.surfaces : ['build'];
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
