import { describe, expect, it } from 'vitest';
import { buildSystemSkills } from './system-skill-registry';

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
});
