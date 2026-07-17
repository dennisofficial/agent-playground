import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSkillFrontmatter } from '../skill-frontmatter';
import { buildSystemSkills } from '../system-skill-registry';
import {
  managedSkillRelativeDir,
  managedSkillsRootHost,
} from '../system-skill-store-paths';

describe('buildSystemSkills', () => {
  it('every entry carries a non-empty name/description/surfaces (documents the shape)', () => {
    expect(buildSystemSkills().length).toBeGreaterThan(0);
    for (const s of buildSystemSkills()) {
      expect(s.name.length).toBeGreaterThan(0);
      expect(s.description.length).toBeGreaterThan(0);
      expect(s.surfaces.length).toBeGreaterThan(0);
    }
  });

  it('a git-sourced entry carries a well-formed source (url/subpath/ref)', () => {
    const gitEntries = buildSystemSkills().filter((s) => s.git);
    expect(gitEntries.length).toBeGreaterThan(0);
    for (const s of gitEntries) {
      expect(s.git?.url).toMatch(/^https:\/\//);
      expect(s.git?.subpath.length).toBeGreaterThan(0);
      expect(s.git?.ref.length).toBeGreaterThan(0);
    }
  });

  it('names are unique across static and git-sourced entries', () => {
    const names = buildSystemSkills().map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('design-patterns is registered unscoped (all surfaces) with a description matching its SKILL.md', () => {
    const designPatterns = buildSystemSkills().find(
      (s) => s.name === 'design-patterns',
    );
    expect(designPatterns).toBeDefined();
    // Unscoped = every agent surface; SkillResolver filters by exact surface, so all three must be listed.
    expect([...designPatterns!.surfaces].sort()).toEqual([
      'brain',
      'build',
      'review',
    ]);
    // Static (in-repo) skill — no git source.
    expect(designPatterns!.git).toBeUndefined();
    // The SDK matches on the registry description, so it MUST equal the committed SKILL.md frontmatter.
    const skillMd = readFileSync(
      join(
        managedSkillsRootHost(),
        managedSkillRelativeDir('design-patterns'),
        'SKILL.md',
      ),
      'utf8',
    );
    expect(designPatterns!.description).toBe(
      parseSkillFrontmatter(skillMd).description,
    );
  });
});
