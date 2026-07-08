import { describe, expect, it } from 'vitest';
import { buildSystemSkills } from './system-skill-registry';

describe('buildSystemSkills', () => {
  it('ships with none by default — the mechanism, not invented content', () => {
    expect(buildSystemSkills()).toEqual([]);
  });

  it('any entry that IS added carries a non-empty name/description/surfaces (documents the shape)', () => {
    for (const s of buildSystemSkills()) {
      expect(s.name.length).toBeGreaterThan(0);
      expect(s.description.length).toBeGreaterThan(0);
      expect(s.surfaces.length).toBeGreaterThan(0);
    }
  });
});
