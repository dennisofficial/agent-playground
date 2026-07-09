import { Injectable } from '@nestjs/common';
import type { ResolvedSkill } from '../engine/engine.types';
import type { McpSurface, WorkspaceSkillEntity } from '../persistence/entities';
import { managedGitSkillRelativeDir, skillRelativeDir } from './skill-store-paths';
import { buildSystemSkills } from './system-skill-registry';
import { managedSkillRelativeDir } from './system-skill-store-paths';
import { WorkspaceSkillStore } from './workspace-skill.store';

/**
 * The turn seam for skills — the analogue of `McpResolver` for `workspace_skills`, PLUS the code-defined
 * system tier (`system-skill-registry.ts`, the skills counterpart of `system-mcp-registry.ts`). Given a
 * turn's org, repo, and surface, it returns the enabled skills as `{name, description, dirPath, managed?}`
 * — a dir path relative to the org-scoped skills-store root (or, for a `managed` entry, the MANAGED skills
 * root — see `engine-core.ts`'s `composeSkillsDir`), NOT a body — to thread onto `RunEngineArgs.skills`.
 * Injected by the brain + driver turn-assembly paths (`@Global` module), exactly like `McpResolver`.
 *
 * Precedence (lowest to highest): the system tier is the BASE layer, then org-scoped, then repo-scoped —
 * a workspace skill OVERRIDES a managed one of the same `name`, and a repo-scoped workspace skill
 * OVERRIDES an org-scoped one. Unlike MCP's system tier (attached via a separate hardcoded bridge, never
 * through `McpResolver`), a skill MUST go through this seam to reach `<CLAUDE_CONFIG_DIR>/skills/` at all
 * — so the merge lives here, not in a parallel resolver the brain/driver would also have to call.
 */
@Injectable()
export class SkillResolver {
  constructor(private readonly store: WorkspaceSkillStore) {}

  /**
   * Resolve every enabled skill whose `surfaces` include `surface`, for this org + repo, system tier as the
   * base layer with repo scope overriding org scope overriding a managed skill of the same name. Returns
   * `[]` when there are none (the common path while the system tier ships empty and the org has no skills).
   */
  async resolveForTurn(
    orgId: string,
    repoId: string,
    surface: McpSurface,
  ): Promise<ResolvedSkill[]> {
    const byName = new Map<string, ResolvedSkill>();
    for (const s of buildSystemSkills()) {
      if (!s.surfaces.includes(surface)) continue;
      byName.set(
        s.name,
        s.git
          ? { name: s.name, description: s.description, dirPath: managedGitSkillRelativeDir(s.name), managedGit: true }
          : { name: s.name, description: s.description, dirPath: managedSkillRelativeDir(s.name), managed: true },
      );
    }

    const rows = await this.store.rowsForTurn(orgId, repoId);
    const winners = new Map<string, WorkspaceSkillEntity>();
    for (const r of rows) {
      if (!r.enabled) continue;
      if (!r.surfaces.includes(surface)) continue;
      const winner = winners.get(r.name);
      // A repo-scoped row (scope !== '*') always beats an org-scoped one; otherwise first-seen org wins.
      if (!winner || (winner.scope === '*' && r.scope !== '*')) winners.set(r.name, r);
    }
    for (const r of winners.values()) {
      byName.set(r.name, { name: r.name, description: r.description, dirPath: skillRelativeDir(r.scope, r.name) });
    }

    return [...byName.values()];
  }
}
