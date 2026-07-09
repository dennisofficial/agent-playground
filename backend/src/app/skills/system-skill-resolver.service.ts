import { EnvService } from '@core/config/env/env.service';
import { Injectable } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { managedGitSkillDirHost } from './skill-store-paths';
import { buildSystemSkills, type SystemSkill } from './system-skill-registry';

/** A `SystemSkill` as returned to the console — a git-sourced entry additionally carries whether
 *  `ManagedSkillSyncService` has actually vendored it to disk yet (a fresh boot can list one before its
 *  first sync completes; the console shows it as pending rather than pretending it's already active). */
export interface SystemSkillView extends SystemSkill {
  /** Absent for a static entry (always "synced" — it's committed to the repo). For a `git` entry: `true`
   *  once its `SKILL.md` is on disk under the global `_managed` store, `false` if not vendored yet. */
  synced?: boolean;
}

/**
 * Resolves the SYSTEM tier of skills — Atlas's own code-defined built-ins — for the console's Skills page.
 * The skills counterpart of `SystemMcpResolver`. A STATIC entry has no live-signal gating (its files are
 * either on disk or not — `SkillResolver.resolveForTurn`, the seam that actually attaches it to a turn,
 * checks that at compose time, not here); a GIT-SOURCED entry DOES get one light disk check here — whether
 * `ManagedSkillSyncService` has vendored it yet — purely for the console's pending/synced display, still
 * never through a store. No org param needed — the list is the same for every org.
 */
@Injectable()
export class SystemSkillResolver {
  constructor(private readonly env: EnvService) {}

  list(): SystemSkillView[] {
    const root = this.env.get('SKILLS_ROOT');
    return buildSystemSkills().map((s) =>
      s.git ? { ...s, synced: existsSync(join(managedGitSkillDirHost(root, s.name), 'SKILL.md')) } : s,
    );
  }
}
