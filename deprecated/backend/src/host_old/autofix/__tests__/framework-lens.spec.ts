import type { EnvService } from '@core/config/env/env.service';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { WorkspaceSkillEntity } from '../../persistence/entities';
import { buildReviewPrompt } from '../../prompt-kit/messages/autofix-lenses';
import { parseSkillFrontmatter, stripSkillFrontmatter } from '../../skills/skill-frontmatter';
import { SkillResolver } from '../../skills/skill-resolver.service';
import { orgSkillsRootHost, skillRelativeDir } from '../../skills/skill-store-paths';
import type { WorkspaceSkillStore } from '../../skills/workspace-skill.store';
import { lensById, reviewAgentsForThread } from '../autofix-lenses';
import type { AutoFixContext } from '../autofix.types';

vi.mock('../../skills/system-skill-registry', () => ({
  buildSystemSkills: () => [],
}));

const baseCtx: AutoFixContext = {
  worktreePath: '/tmp/wt',
  sandboxKey: {
    orgId: 'acme',
    repoId: 'atlas',
    jobId: 'feat',
    type: 'autofix',
  },
  intent: 'add a y constant',
};

describe('parseSkillFrontmatter — reviewForTypes/reviewForGlobs', () => {
  it('parses the documented snake_case list keys into the camelCase DTO fields', () => {
    const md = '---\nname: x\nreview_for_types: [frontend]\nreview_for_globs: **/*.tsx\n---\nbody';
    const fm = parseSkillFrontmatter(md);
    expect(fm.reviewForTypes).toEqual(['frontend']);
    expect(fm.reviewForGlobs).toEqual(['**/*.tsx']);
  });

  it('parses the bracketed list form `[a, b]` into a string array', () => {
    const md = '---\nname: x\nreviewForTypes: [frontend, backend]\n---\nbody';
    expect(parseSkillFrontmatter(md).reviewForTypes).toEqual(['frontend', 'backend']);
  });

  it('parses the bare comma form `a, b` into a string array', () => {
    const md = '---\nname: x\nreviewForGlobs: **/*.tsx, backend/**\n---\nbody';
    expect(parseSkillFrontmatter(md).reviewForGlobs).toEqual(['**/*.tsx', 'backend/**']);
  });

  it('parses both keys together on a full frontmatter block', () => {
    const md =
      '---\nname: react-review-checklist\ndescription: d\n' +
      'reviewForTypes: [frontend]\nreviewForGlobs: **/*.tsx, **/*.jsx\n---\nbody text';
    const fm = parseSkillFrontmatter(md);
    expect(fm.name).toBe('react-review-checklist');
    expect(fm.reviewForTypes).toEqual(['frontend']);
    expect(fm.reviewForGlobs).toEqual(['**/*.tsx', '**/*.jsx']);
  });

  it('leaves reviewForTypes/reviewForGlobs undefined when the keys are absent', () => {
    const md = '---\nname: x\ndescription: y\n---\nbody';
    const fm = parseSkillFrontmatter(md);
    expect(fm.reviewForTypes).toBeUndefined();
    expect(fm.reviewForGlobs).toBeUndefined();
  });

  it('an empty list value (e.g. `reviewForTypes:` with nothing after it) is treated as absent', () => {
    const md = '---\nname: x\nreviewForTypes:\n---\nbody';
    expect(parseSkillFrontmatter(md).reviewForTypes).toBeUndefined();
  });
});

describe('stripSkillFrontmatter', () => {
  it('removes the frontmatter block and returns the trimmed body', () => {
    const md = '---\nname: x\ndescription: y\n---\n\n# Body\n\nSome content.\n';
    expect(stripSkillFrontmatter(md)).toBe('# Body\n\nSome content.');
  });

  it('returns the trimmed input unchanged when there is no frontmatter block', () => {
    const md = '\n# No frontmatter here\n';
    expect(stripSkillFrontmatter(md)).toBe('# No frontmatter here');
  });
});

describe('reviewAgentsForThread — framework axis', () => {
  it('empty (default) frameworkSkillNames -> no framework lens', () => {
    expect(reviewAgentsForThread('frontend').map((l) => l.id)).not.toContain('framework');
    expect(reviewAgentsForThread('frontend', []).map((l) => l.id)).not.toContain('framework');
  });

  it('a non-empty frameworkSkillNames -> the framework lens is appended LAST', () => {
    const ids = reviewAgentsForThread('frontend', ['react-review-checklist']).map((l) => l.id);
    expect(ids[ids.length - 1]).toBe('framework');
    expect(ids).toEqual(['correctness', 'holistic', 'framework']);
  });

  it('docs still drops correctness, framework still appended last', () => {
    const ids = reviewAgentsForThread('docs', ['react-review-checklist']).map((l) => l.id);
    expect(ids).toEqual(['holistic', 'framework']);
  });

  it('data still adds data_safety on top of the always-on lenses, framework appended after it', () => {
    const ids = reviewAgentsForThread('data', ['react-review-checklist']).map((l) => l.id);
    expect(ids).toEqual(['correctness', 'holistic', 'data_safety', 'framework']);
  });

  it('docs still omits correctness with no framework names', () => {
    const ids = reviewAgentsForThread('docs').map((l) => l.id);
    expect(ids).not.toContain('correctness');
  });

  it('data still includes data_safety with no framework names', () => {
    expect(reviewAgentsForThread('data').map((l) => l.id)).toContain('data_safety');
  });
});

describe('buildReviewPrompt — framework lens body injection', () => {
  const frameworkLens = lensById('framework');
  const otherLens = lensById('correctness')!;
  const injectedBody = 'Never use array index as a key.';
  const ctxWithBodies: AutoFixContext = {
    ...baseCtx,
    frameworkBodies: [{ name: 'react-review-checklist', body: injectedBody }],
  };

  it('lensById resolves the framework lens with scope "framework"', () => {
    expect(frameworkLens).toBeDefined();
    expect(frameworkLens?.scope).toBe('framework');
    expect(frameworkLens?.id).toBe('framework');
  });

  it('renders the injected skill body AND the skill name label for the framework lens', () => {
    const p = buildReviewPrompt(frameworkLens!, ctxWithBodies);
    expect(p).toContain(injectedBody);
    expect(p).toContain('react-review-checklist');
  });

  it('a NON-framework lens given the same ctx does NOT render the injected body', () => {
    const p = buildReviewPrompt(otherLens, ctxWithBodies);
    expect(p).not.toContain(injectedBody);
  });

  it('the framework lens with no frameworkBodies on ctx renders no dangling injection block', () => {
    const p = buildReviewPrompt(frameworkLens!, baseCtx);
    expect(p).not.toContain(injectedBody);
    expect(p).toContain(frameworkLens!.label);
  });
});

describe('SkillResolver.resolveReviewSkillsForThread', () => {
  const orgId = 'org1';
  const repoId = 'repo-1';
  const skillName = 'fake-framework-skill';
  const skillBody = '# Rules\n\n- Never use array index as a list key.';
  const skillMd = `---\nname: ${skillName}\ndescription: fake skill for testing\n---\n\n${skillBody}\n`;

  let tempRoot: string;
  let fakeEnv: EnvService;

  beforeAll(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'atlas-skills-test-'));
    const dir = join(orgSkillsRootHost(tempRoot, orgId), skillRelativeDir('*', skillName));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), skillMd, 'utf8');
    fakeEnv = {
      get: (key: string) => (key === 'SKILLS_ROOT' ? tempRoot : undefined),
    } as unknown as EnvService;
  });

  afterAll(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  const baseRow: Partial<WorkspaceSkillEntity> = {
    org_id: orgId,
    scope: '*',
    name: skillName,
    description: 'fake skill for testing',
    surfaces: ['review'],
    enabled: true,
    review_for_types: ['frontend'],
    review_for_globs: ['**/*.tsx'],
  };

  function makeResolver(row: Partial<WorkspaceSkillEntity>): SkillResolver {
    const store = {
      rowsForTurn: async () => [row as WorkspaceSkillEntity],
    } as unknown as WorkspaceSkillStore;
    return new SkillResolver(store, fakeEnv);
  }

  it('matches by thread type when no changed file matches the glob', async () => {
    const resolver = makeResolver(baseRow);
    const out = await resolver.resolveReviewSkillsForThread(orgId, repoId, 'frontend', [
      'backend/index.ts',
    ]);
    expect(out.map((s) => s.name)).toEqual([skillName]);
  });

  it('matches by changed-file glob when the thread type does not match', async () => {
    const resolver = makeResolver(baseRow);
    const out = await resolver.resolveReviewSkillsForThread(orgId, repoId, 'backend', [
      'src/Component.tsx',
    ]);
    expect(out.map((s) => s.name)).toEqual([skillName]);
  });

  it('excludes the skill when NEITHER axis matches', async () => {
    const resolver = makeResolver(baseRow);
    const out = await resolver.resolveReviewSkillsForThread(orgId, repoId, 'backend', [
      'backend/index.ts',
    ]);
    expect(out).toEqual([]);
  });

  it('a matched skill returns its SKILL.md body with frontmatter stripped', async () => {
    const resolver = makeResolver(baseRow);
    const [match] = await resolver.resolveReviewSkillsForThread(orgId, repoId, 'frontend', []);
    expect(match).toBeDefined();
    expect(match.name).toBe(skillName);
    expect(match.body).toBe(skillBody.trim());
    expect(match.body).not.toContain('---');
    expect(match.body).not.toContain('description: fake skill for testing');
  });

  it('a skill with neither axis set (both empty) never matches — explicit opt-in', async () => {
    const resolver = makeResolver({
      ...baseRow,
      review_for_types: [],
      review_for_globs: [],
    });
    const out = await resolver.resolveReviewSkillsForThread(orgId, repoId, 'frontend', [
      'src/Component.tsx',
    ]);
    expect(out).toEqual([]);
  });
});
