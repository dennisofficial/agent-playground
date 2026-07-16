import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { RunEngineArgs } from '../engine.types';

/**
 * Compose this turn's resolved skills into `<claudeConfigDir>/skills/` as write-through symlinks into the
 * central skills store — a `managed` skill from `managedSkillsRoot` (Atlas's own STATIC built-ins,
 * `CONTAINER_SKILLS_MANAGED`), a `managedGit` skill from `managedGitSkillsRoot` (Atlas's GIT-SOURCED
 * built-ins, synced by `ManagedSkillSyncService`, `CONTAINER_SKILLS_MANAGED_GIT`), every other skill from
 * `skillsRoot` (the org-scoped store, `CONTAINER_SKILLS_STORE`) — for the SDK to discover NATIVELY
 * (`settingSources: ['user','project']` + `skills: 'all'`, below) — no synthetic plugin. Idempotent wipe+rewrite
 * EVERY turn (the config dir is durable across turns, so a skill removed/disabled since last turn must not
 * linger — same discipline the old plugin-render step used). A skill whose source dir isn't actually on
 * disk under its root yet (e.g. its DB row exists but nothing installed/authored the files, OR a
 * `managedGit` entry `ManagedSkillSyncService` hasn't vendored yet) is skipped rather than left as a
 * dangling symlink. `SkillResolver` already resolved precedence (a workspace skill overrides a managed one
 * of the same name) into ONE entry per name, so this step never sees more than one root per entry — it
 * just symlinks whichever root each entry says.
 */
export function composeSkillsDir(
  claudeConfigDir: string,
  skills: RunEngineArgs['skills'],
  skillsRoot: string | undefined,
  managedSkillsRoot: string | undefined,
  managedGitSkillsRoot?: string,
): void {
  const skillsDir = join(claudeConfigDir, 'skills');
  rmSync(skillsDir, { recursive: true, force: true });
  if (
    !skills ||
    skills.length === 0 ||
    (!skillsRoot && !managedSkillsRoot && !managedGitSkillsRoot)
  )
    return;
  mkdirSync(skillsDir, { recursive: true });
  for (const skill of skills) {
    // Defensive: skill names are validated kebab at authoring time, but never let one escape skillsDir.
    const safeName = skill.name.replace(/[^a-z0-9_-]/gi, '-') || 'skill';
    const root = skill.managedGit
      ? managedGitSkillsRoot
      : skill.managed
        ? managedSkillsRoot
        : skillsRoot;
    if (!root) continue;
    const source = join(root, skill.dirPath);
    if (!existsSync(source)) continue;
    symlinkSync(source, join(skillsDir, safeName), 'dir');
  }
}
