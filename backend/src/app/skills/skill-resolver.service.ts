import { Injectable } from '@nestjs/common';
import type { ResolvedSkill } from '../engine/engine.types';
import type { McpSurface, WorkspaceSkillEntity } from '../persistence/entities';
import { WorkspaceSkillStore } from './workspace-skill.store';

/**
 * The turn seam for skills — the analogue of `McpResolver` for `workspace_skills`. Given a turn's org,
 * repo, and surface, it returns the enabled skills (as plain `{name, description, body}`) to thread onto
 * `RunEngineArgs.skills`. Injected by the brain + driver turn-assembly paths (`@Global` module), exactly
 * like `McpResolver`.
 *
 * Precedence: a repo-scoped skill OVERRIDES an org-scoped skill of the same `name` — repo config wins.
 */
@Injectable()
export class SkillResolver {
  constructor(private readonly store: WorkspaceSkillStore) {}

  /**
   * Resolve every enabled skill whose `surfaces` include `surface`, for this org + repo, with repo scope
   * overriding org scope by name. Returns `[]` when there are none (the common path).
   */
  async resolveForTurn(
    orgId: string,
    repoId: string,
    surface: McpSurface,
  ): Promise<ResolvedSkill[]> {
    const rows = await this.store.rowsForTurn(orgId, repoId);
    if (rows.length === 0) return [];

    const byName = new Map<string, WorkspaceSkillEntity>();
    for (const r of rows) {
      if (!r.enabled) continue;
      if (!r.surfaces.includes(surface)) continue;
      const winner = byName.get(r.name);
      // A repo-scoped row (scope !== '*') always beats an org-scoped one; otherwise first-seen org wins.
      if (!winner || (winner.scope === '*' && r.scope !== '*')) byName.set(r.name, r);
    }

    return [...byName.values()].map((r) => ({
      name: r.name,
      description: r.description,
      body: r.body,
    }));
  }
}
