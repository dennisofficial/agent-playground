import { EnvService } from '@core/config/env/env.service';
import { Injectable, Logger } from '@nestjs/common';
import type { ResolvedSkill } from '@shared/engine/engine.types';
import type { ThreadType } from '@shared/thread-kind/thread-types';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import picomatch from 'picomatch';
import type { McpSurface, WorkspaceSkillEntity } from '../persistence/entities';
import { stripSkillFrontmatter } from './skill-frontmatter';
import {
  managedGitSkillRelativeDir,
  managedGitSkillsRootHost,
  orgSkillsRootHost,
  skillRelativeDir,
} from './skill-store-paths';
import { buildSystemSkills } from './system-skill-registry';
import { managedSkillRelativeDir, managedSkillsRootHost } from './system-skill-store-paths';
import { WorkspaceSkillStore } from './workspace-skill.store';

@Injectable()
export class SkillResolver {
  private readonly logger = new Logger(SkillResolver.name);

  constructor(
    private readonly store: WorkspaceSkillStore,
    private readonly env: EnvService,
  ) {}

  async resolveForTurn(
    orgId: string,
    repoId: string,
    surface: McpSurface,
  ): Promise<ResolvedSkill[]> {
    const byName = new Map<string, ResolvedSkill>();
    for (const s of buildSystemSkills()) {
      if (!s.surfaces.includes(surface)) continue;
      const reviewForTypes = s.reviewForTypes ?? [];
      const reviewForGlobs = s.reviewForGlobs ?? [];
      byName.set(
        s.name,
        s.git
          ? {
              name: s.name,
              description: s.description,
              dirPath: managedGitSkillRelativeDir(s.name),
              managedGit: true,
              reviewForTypes,
              reviewForGlobs,
            }
          : {
              name: s.name,
              description: s.description,
              dirPath: managedSkillRelativeDir(s.name),
              managed: true,
              reviewForTypes,
              reviewForGlobs,
            },
      );
    }

    const rows = await this.store.rowsForTurn(orgId, repoId);
    const winners = new Map<string, WorkspaceSkillEntity>();
    for (const r of rows) {
      if (!r.enabled) continue;
      if (!r.surfaces.includes(surface)) continue;
      const winner = winners.get(r.name);
      if (!winner || (winner.scope === '*' && r.scope !== '*')) winners.set(r.name, r);
    }
    for (const r of winners.values()) {
      byName.set(r.name, {
        name: r.name,
        description: r.description,
        dirPath: skillRelativeDir(r.scope, r.name),
        reviewForTypes: r.review_for_types ?? [],
        reviewForGlobs: r.review_for_globs ?? [],
      });
    }

    return [...byName.values()];
  }

  async resolveReviewSkillsForThread(
    orgId: string,
    repoId: string,
    type: ThreadType,
    changedFiles: string[],
  ): Promise<{ name: string; body: string }[]> {
    const resolved = await this.resolveForTurn(orgId, repoId, 'review');
    const root = this.env.get('SKILLS_ROOT');
    const out: { name: string; body: string }[] = [];
    for (const s of resolved) {
      const types = s.reviewForTypes ?? [];
      const globs = s.reviewForGlobs ?? [];
      const applies =
        types.includes(type) ||
        globs.some((g) => changedFiles.some((f) => picomatch.isMatch(f, g)));
      if (!applies) continue;

      const rootForSkill = s.managed
        ? managedSkillsRootHost()
        : s.managedGit
          ? managedGitSkillsRootHost(root)
          : orgSkillsRootHost(root, orgId);
      const abs = join(rootForSkill, s.dirPath);
      try {
        const md = readFileSync(join(abs, 'SKILL.md'), 'utf8');
        out.push({ name: s.name, body: stripSkillFrontmatter(md) });
      } catch (err) {
        this.logger.warn(
          `skipping review skill '${s.name}' — failed to read SKILL.md at ${abs}: ${err}`,
        );
      }
    }
    return out;
  }
}
