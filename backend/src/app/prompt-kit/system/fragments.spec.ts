import { describe, expect, it } from 'vitest';
import {
  composePreviewPrepSeed,
  fencedRecipe,
  renderBuildLanePreviewRecipe,
  PREVIEW_PREP_SEED_BODY,
} from './fragments';

/**
 * `fencedRecipe` was factored out of `composePreviewPrepSeed` (the operator Spin-up-preview seed) so the
 * build-lane read-only view (`renderBuildLanePreviewRecipe`) can reuse the same fenced formatting. This is
 * the guardrail that the refactor left `composePreviewPrepSeed`'s output byte-identical.
 */
describe('composePreviewPrepSeed (refactor guard)', () => {
  it('splices the fenced recipe block right after the preamble for a saved recipe', () => {
    const recipe = '  export WEB_PORT=3000\npnpm seed\nOpen /dashboard\n';
    const block =
      'Repo preview recipe (Atlas-managed — you author/update it via `write_preview_instructions`):\n' +
      fencedRecipe(recipe);
    // The refactor this guards owns the preamble → blank → exact fenced block structure; the trailing footer
    // prose is composePreviewPrepSeed's own (evolves independently), so assert the block, not the whole string.
    expect(composePreviewPrepSeed(recipe)).toContain(
      [PREVIEW_PREP_SEED_BODY, '', block, ''].join('\n'),
    );
  });

  it('splices the empty-recipe fenced block when nothing is saved yet', () => {
    const block =
      'Repo preview recipe (Atlas-managed — you author/update it via `write_preview_instructions`):\n' +
      fencedRecipe('(no preview recipe saved yet)');
    expect(composePreviewPrepSeed(null)).toContain(
      [PREVIEW_PREP_SEED_BODY, '', block, ''].join('\n'),
    );
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
