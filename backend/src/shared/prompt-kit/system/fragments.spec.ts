import { describe, expect, it } from 'vitest';
import {
  composePreviewPrepSeed,
  fencedRecipe,
  PREVIEW_PREP_SEED_BODY,
  renderBuildLanePreviewRecipe,
} from './fragments';

describe('composePreviewPrepSeed (refactor guard)', () => {
  it('splices the fenced recipe block right after the preamble for a saved recipe', () => {
    const recipe = '  export WEB_PORT=3000\npnpm seed\nOpen /dashboard\n';
    const block =
      'Repo preview recipe (Atlas-managed — you author/update it via `write_preview_instructions`):\n' +
      fencedRecipe(recipe);
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
