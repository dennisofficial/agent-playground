import { describe, expect, it } from 'vitest';
import { composePreviewPrepSeed, fencedRecipe, renderBuildLanePreviewRecipe, PREVIEW_PREP_SEED_BODY } from './fragments';

/**
 * `fencedRecipe` was factored out of `composePreviewPrepSeed` (the operator Spin-up-preview seed) so the
 * build-lane read-only view (`renderBuildLanePreviewRecipe`) can reuse the same fenced formatting. This is
 * the guardrail that the refactor left `composePreviewPrepSeed`'s output byte-identical.
 */
describe('composePreviewPrepSeed (refactor guard)', () => {
  it('is byte-identical for a saved recipe', () => {
    const recipe = '  export WEB_PORT=3000\npnpm seed\nOpen /dashboard\n';
    const block =
      'Repo preview recipe (Atlas-managed — you author/update it via `write_preview_instructions`):\n' +
      fencedRecipe(recipe);
    const footer =
      'Follow/adapt this saved recipe to stand the preview up fast. If it is stale or wrong once you have the ' +
      'preview working, UPDATE it with `write_preview_instructions` (it REPLACES the whole recipe — ' +
      '`read_preview_instructions` first to amend). To edit it any time, use those two tools.';
    expect(composePreviewPrepSeed(recipe)).toBe([PREVIEW_PREP_SEED_BODY, '', block, '', footer].join('\n'));
  });

  it('is byte-identical when nothing is saved yet', () => {
    const block =
      'Repo preview recipe (Atlas-managed — you author/update it via `write_preview_instructions`):\n' +
      fencedRecipe('(no preview recipe saved yet)');
    const footer =
      'No recipe saved yet — once you get this preview working, SAVE the exact repeatable steps (envs to set, ' +
      'ports, docker compose / migrate / seed commands, the deep-link) with `write_preview_instructions` so the ' +
      'NEXT Spin up preview is instant instead of re-discovered.';
    expect(composePreviewPrepSeed(null)).toBe([PREVIEW_PREP_SEED_BODY, '', block, '', footer].join('\n'));
  });
});

describe('renderBuildLanePreviewRecipe', () => {
  it('contains the fenced recipe + READ-ONLY framing when a recipe is present', () => {
    const out = renderBuildLanePreviewRecipe('docker compose up -d postgres');
    expect(out).toContain(fencedRecipe('docker compose up -d postgres'));
    expect(out).toContain('READ-ONLY');
  });

  it('returns "" for null', () => {
    expect(renderBuildLanePreviewRecipe(null)).toBe('');
  });

  it('returns "" for a whitespace-only recipe', () => {
    expect(renderBuildLanePreviewRecipe('   ')).toBe('');
  });
});
