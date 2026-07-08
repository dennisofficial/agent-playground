import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { composeSkillsDir } from './engine-core';

/**
 * `composeSkillsDir`'s handling of `ResolvedSkill.managed` — the P5 system-skills tier. Not a resolver
 * test (see `skill-resolver.managed-tier.spec.ts` for the precedence MERGE); this checks the compose step
 * itself picks the right root per entry and never leaves a dangling symlink.
 */
const ROOT = join(tmpdir(), `atlas-managed-skills-compose-spec-${process.pid}`);
const CLAUDE_CONFIG_DIR = join(ROOT, 'claude-config');
const SKILLS_ROOT = join(ROOT, 'org-skills');
const MANAGED_ROOT = join(ROOT, 'managed-skills');
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

function writeSkillMd(dir: string, description: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\ndescription: ${description}\n---\nbody\n`);
}

describe('composeSkillsDir — managed (system) skills', () => {
  it('composes a managed skill from the MANAGED root, not the org-scoped store', () => {
    writeSkillMd(join(MANAGED_ROOT, 'atlas-example'), 'managed');
    composeSkillsDir(
      CLAUDE_CONFIG_DIR,
      [{ name: 'atlas-example', description: 'managed', dirPath: 'atlas-example', managed: true }],
      SKILLS_ROOT,
      MANAGED_ROOT,
    );
    const link = join(CLAUDE_CONFIG_DIR, 'skills', 'atlas-example');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(join(MANAGED_ROOT, 'atlas-example'));
    expect(existsSync(join(link, 'SKILL.md'))).toBe(true);
  });

  it('a non-managed entry still resolves against the org-scoped skillsRoot as before', () => {
    writeSkillMd(join(SKILLS_ROOT, 'shared'), 'org');
    composeSkillsDir(
      CLAUDE_CONFIG_DIR,
      [{ name: 'shared', description: 'org', dirPath: 'shared' }],
      SKILLS_ROOT,
      MANAGED_ROOT,
    );
    const link = join(CLAUDE_CONFIG_DIR, 'skills', 'shared');
    expect(readlinkSync(link)).toBe(join(SKILLS_ROOT, 'shared'));
  });

  it('a managed skill missing its files on disk is skipped, not a dangling symlink', () => {
    composeSkillsDir(
      CLAUDE_CONFIG_DIR,
      [{ name: 'ghost', description: 'd', dirPath: 'ghost', managed: true }],
      SKILLS_ROOT,
      MANAGED_ROOT,
    );
    expect(existsSync(join(CLAUDE_CONFIG_DIR, 'skills', 'ghost'))).toBe(false);
  });

  it('a managed skill composes even with no org-scoped skillsRoot at all', () => {
    writeSkillMd(join(MANAGED_ROOT, 'no-org-root'), 'managed');
    composeSkillsDir(
      CLAUDE_CONFIG_DIR,
      [{ name: 'no-org-root', description: 'managed', dirPath: 'no-org-root', managed: true }],
      undefined,
      MANAGED_ROOT,
    );
    const link = join(CLAUDE_CONFIG_DIR, 'skills', 'no-org-root');
    expect(readlinkSync(link)).toBe(join(MANAGED_ROOT, 'no-org-root'));
  });
});
