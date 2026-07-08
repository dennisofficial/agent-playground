import { describe, expect, it } from 'vitest';
import { applyConventionsToAgents } from './engine-core';
import { Agent } from '../prompt-kit/agent';
import { renderAgentPrompt } from '../prompt-kit/assemble';

/**
 * The engine-assembled subagent personas are built IN-CONTAINER from static prompts, so the wire-forwarded
 * `repoConventions` reaches the FAN_OUT writers + REVIEW_AGENT only through `applyConventionsToAgents`. This
 * is the primary failure mode: without it, the house style reaches the main agent's `systemPrompt` but never
 * the file-writing subagents. Advisory subagents (explore/test/validate) must stay untouched.
 */
const MARKER = 'REPO HOUSE CONVENTIONS';
const PROFILE = { name: 'NestJS + Next + shared', body: 'Author DTOs in shared/, imported by both ends.' };

// A minimal stand-in agents map with the same keys the engine composes (prompts as the static renders).
const baseAgents = () => ({
  explore: { description: 'x', prompt: renderAgentPrompt(Agent.EXPLORE) },
  review: { description: 'x', prompt: renderAgentPrompt(Agent.REVIEW_AGENT) },
  implement: { description: 'x', prompt: renderAgentPrompt(Agent.FAN_OUT) },
  'implement-deep': { description: 'x', prompt: renderAgentPrompt(Agent.FAN_OUT) },
  validate: { description: 'x', prompt: renderAgentPrompt(Agent.VALIDATE) },
});

describe('applyConventionsToAgents', () => {
  it('returns the map UNCHANGED when no profile is attached (null / undefined)', () => {
    const agents = baseAgents();
    expect(applyConventionsToAgents(agents, null)).toBe(agents);
    expect(applyConventionsToAgents(agents, undefined)).toBe(agents);
  });

  it('folds the envelope into the FAN_OUT writers and the REVIEW_AGENT', () => {
    const out = applyConventionsToAgents(baseAgents(), PROFILE);
    for (const name of ['implement', 'implement-deep', 'review'] as const) {
      expect(out[name].prompt).toContain(MARKER);
      expect(out[name].prompt).toContain(PROFILE.body);
    }
  });

  it('leaves the advisory subagents (explore/validate) free of the envelope', () => {
    const out = applyConventionsToAgents(baseAgents(), PROFILE);
    expect(out.explore.prompt).not.toContain(MARKER);
    expect(out.validate.prompt).not.toContain(MARKER);
  });

  it('does not mutate the input map (returns a copy)', () => {
    const agents = baseAgents();
    const before = agents.implement.prompt;
    applyConventionsToAgents(agents, PROFILE);
    expect(agents.implement.prompt).toBe(before);
  });
});
