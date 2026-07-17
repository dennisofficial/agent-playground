import { describe, expect, it } from 'vitest';
import { Agent } from '../prompt-kit/system/agent';
import { renderAgentPrompt } from '../prompt-kit/system/assemble';
import { applyPerRunCtxToAgents } from './engine-core';

const CONVENTIONS_MARKER = 'REPO HOUSE CONVENTIONS';
const PROFILE = {
  name: 'NestJS + Next + shared',
  body: 'Author DTOs in shared/, imported by both ends.',
};
const RECIPE = 'docker compose up -d postgres && pnpm start:dev';

const baseAgents = () => ({
  explore: { description: 'x', prompt: renderAgentPrompt(Agent.EXPLORE) },
  review: { description: 'x', prompt: renderAgentPrompt(Agent.REVIEW_AGENT) },
  implement: { description: 'x', prompt: renderAgentPrompt(Agent.FAN_OUT) },
  'implement-deep': {
    description: 'x',
    prompt: renderAgentPrompt(Agent.FAN_OUT),
  },
  validate: { description: 'x', prompt: renderAgentPrompt(Agent.VALIDATE) },
});

describe('applyPerRunCtxToAgents', () => {
  it('returns the map UNCHANGED when neither repoConventions nor previewInstructions is set', () => {
    const agents = baseAgents();
    expect(applyPerRunCtxToAgents(agents, { repoConventions: null })).toBe(agents);
    expect(applyPerRunCtxToAgents(agents, { repoConventions: undefined })).toBe(agents);
    expect(
      applyPerRunCtxToAgents(agents, {
        repoConventions: null,
        previewInstructions: null,
      }),
    ).toBe(agents);
    expect(
      applyPerRunCtxToAgents(agents, {
        repoConventions: null,
        previewInstructions: '   ',
      }),
    ).toBe(agents);
  });

  it('folds the conventions envelope into the FAN_OUT writers and the REVIEW_AGENT', () => {
    const out = applyPerRunCtxToAgents(baseAgents(), {
      repoConventions: PROFILE,
    });
    for (const name of ['implement', 'implement-deep', 'review'] as const) {
      expect(out[name].prompt).toContain(CONVENTIONS_MARKER);
      expect(out[name].prompt).toContain(PROFILE.body);
    }
  });

  it('leaves validate untouched when only repoConventions is set', () => {
    const out = applyPerRunCtxToAgents(baseAgents(), {
      repoConventions: PROFILE,
    });
    expect(out.explore.prompt).not.toContain(CONVENTIONS_MARKER);
    expect(out.validate.prompt).not.toContain(CONVENTIONS_MARKER);
    expect(out.validate.prompt).not.toContain(RECIPE);
  });

  it('re-renders validate with the preview recipe when previewInstructions is set', () => {
    const out = applyPerRunCtxToAgents(baseAgents(), {
      repoConventions: null,
      previewInstructions: RECIPE,
    });
    expect(out.validate.prompt).toContain(RECIPE);
    expect(out.validate.prompt).toContain('READ-ONLY');
  });

  it('leaves validate untouched when previewInstructions is absent', () => {
    const agents = baseAgents();
    const before = agents.validate.prompt;
    const out = applyPerRunCtxToAgents(agents, { repoConventions: null });
    expect(out.validate.prompt).toBe(before);
  });

  it('re-renders validate with the recipe AND review/implement with conventions, together', () => {
    const out = applyPerRunCtxToAgents(baseAgents(), {
      repoConventions: PROFILE,
      previewInstructions: RECIPE,
    });
    expect(out.validate.prompt).toContain(RECIPE);
    expect(out.validate.prompt).not.toContain(CONVENTIONS_MARKER);
    for (const name of ['implement', 'implement-deep', 'review'] as const) {
      expect(out[name].prompt).toContain(CONVENTIONS_MARKER);
      expect(out[name].prompt).not.toContain(RECIPE);
    }
  });

  it('does not mutate the input map (returns a copy)', () => {
    const agents = baseAgents();
    const before = agents.implement.prompt;
    applyPerRunCtxToAgents(agents, {
      repoConventions: PROFILE,
      previewInstructions: RECIPE,
    });
    expect(agents.implement.prompt).toBe(before);
  });
});
