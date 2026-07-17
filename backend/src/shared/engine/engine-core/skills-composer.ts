import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { RunEngineArgs } from '../engine.types';

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
