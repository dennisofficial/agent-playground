import { describe, expect, it } from 'vitest';
import { LENSES, LENS_REVIEW_PROMPT, type Lens } from './section-review.prompts';
import {
  FULL_IMPLEMENTATION_REVIEW_PROMPT,
  parseVerdict,
} from './review-pipeline.prompts';

/**
 * The Phase-5 review prompts. Each lens review and the full-implementation review must (1) scope the
 * engine to the given git range, (2) carry the ticket/goal, and (3) end with the machine VERDICT line
 * the pipeline branches on (reuse `parseVerdict`). The four lenses must each render a DISTINCT focus so
 * a single review pass can't hide a problem another lens owns.
 */

const BASE = {
  goal: 'profile-picture upload',
  ticket: '#7 Upload — add avatars',
  range: 'base...feat',
};

describe('LENS_REVIEW_PROMPT', () => {
  it('there are exactly four lenses', () => {
    expect(LENSES).toEqual(['correctness', 'solid', 'dry', 'conventions']);
  });

  it('scopes the diff, carries ticket+goal, and ends with the VERDICT contract', () => {
    const prompt = LENS_REVIEW_PROMPT({ ...BASE, lens: 'correctness' });
    expect(prompt).toContain('git diff base...feat');
    expect(prompt).toContain('profile-picture upload');
    expect(prompt).toContain('#7 Upload');
    expect(prompt).toContain('READ-ONLY');
    // The trailing machine verdict the pipeline reads (an engine echoes one of these as its last line).
    expect(prompt.trimEnd().endsWith('VERDICT: CHANGES')).toBe(true);
    expect(parseVerdict('Found a bug at a.ts:10.\nVERDICT: CHANGES')).toBe('changes');
    expect(parseVerdict('Looks fine.\nVERDICT: PASS')).toBe('pass');
  });

  it('each lens renders a distinct focus', () => {
    const bodies = new Map<Lens, string>();
    for (const lens of LENSES) bodies.set(lens, LENS_REVIEW_PROMPT({ ...BASE, lens }));
    // All four are different prompts.
    expect(new Set(bodies.values()).size).toBe(LENSES.length);
    // And each names its own concern.
    expect(bodies.get('correctness')).toMatch(/CORRECTNESS/);
    expect(bodies.get('solid')).toMatch(/SOLID/);
    expect(bodies.get('dry')).toMatch(/DRY/);
    expect(bodies.get('conventions')).toMatch(/CONVENTIONS/);
  });

  it('weaves the section name in when given', () => {
    const prompt = LENS_REVIEW_PROMPT({ ...BASE, lens: 'dry', section: 'backend' });
    expect(prompt).toContain('"backend" section');
  });
});

describe('FULL_IMPLEMENTATION_REVIEW_PROMPT', () => {
  it('scopes to the whole-feature range, names the seams, and ends with the VERDICT contract', () => {
    const prompt = FULL_IMPLEMENTATION_REVIEW_PROMPT(BASE);
    expect(prompt).toContain('git diff base...feat');
    expect(prompt).toMatch(/section-by-section|sections fit TOGETHER|integration/i);
    expect(prompt).toContain('READ-ONLY');
    expect(prompt.trimEnd().endsWith('VERDICT: CHANGES')).toBe(true);
  });
});
