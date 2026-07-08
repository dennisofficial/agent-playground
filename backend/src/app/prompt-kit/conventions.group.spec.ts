import { describe, expect, it } from 'vitest';
import { Agent } from './agent';
import { renderAgentPrompt } from './assemble';

/**
 * The repo house-style envelope (`conventions.group`) — the repo-scoped sibling of the operator group. It
 * must reach EVERY build-facing audience when a profile is attached, and vanish (byte-identical prompt) when
 * it is not — the no-misfire invariant. The engine-assembled subagents (`FAN_OUT`, `REVIEW_AGENT`) render
 * through this same `renderAgentPrompt` seam in-container, so they are covered here too.
 */
const MARKER = 'REPO HOUSE CONVENTIONS';
const PROFILE = { name: 'NestJS + Next + shared', body: 'Use a shared/ contract dir for all DTOs.' };

// The full build-facing set the fragment declares in `usedBy`.
const BUILD_FACING: Agent[] = [
  Agent.ATLAS_MAIN,
  Agent.WORKER,
  Agent.FAN_OUT,
  Agent.REVIEW_AGENT,
  Agent.META_PLAN_REVIEW,
  Agent.AUTOFIX_REVIEW,
  Agent.AUTOFIX_FIX,
];

// Read-only advisory subagents that must NEVER receive the house-style envelope.
const EXCLUDED: Agent[] = [Agent.EXPLORE, Agent.DOCS, Agent.DEBUG, Agent.TEST, Agent.VALIDATE];

describe('conventions.group — repo house-style envelope', () => {
  it.each(BUILD_FACING)('injects the envelope + body for %s when a profile is attached', (agent) => {
    const out = renderAgentPrompt(agent, { settings: { repoConventions: PROFILE } });
    expect(out).toContain(MARKER);
    expect(out).toContain(PROFILE.name);
    expect(out).toContain(PROFILE.body);
  });

  it.each(BUILD_FACING)('emits NOTHING (byte-identical) for %s when no profile is attached', (agent) => {
    const baseline = renderAgentPrompt(agent);
    const nullish = renderAgentPrompt(agent, { settings: { repoConventions: null } });
    const blank = renderAgentPrompt(agent, { settings: { repoConventions: { name: 'x', body: '   ' } } });
    expect(nullish).not.toContain(MARKER);
    expect(blank).not.toContain(MARKER); // whitespace-only body is treated as absent
    // The no-misfire invariant: absent conventions ⇒ exactly today's prompt.
    expect(nullish).toBe(baseline);
    expect(blank).toBe(baseline);
  });

  it.each(EXCLUDED)('never injects the envelope for the advisory subagent %s', (agent) => {
    const out = renderAgentPrompt(agent, { settings: { repoConventions: PROFILE } });
    expect(out).not.toContain(MARKER);
  });

  it('appends the envelope at the tail (operator-layer), not the head', () => {
    // Use an onboarding ctx so the build-brain-only "notice drift" fragment (order 9110) is absent and the
    // envelope (9100) is genuinely the last block — the property under test.
    const baseline = renderAgentPrompt(Agent.ATLAS_MAIN, { jobKind: 'onboarding' });
    const withConv = renderAgentPrompt(Agent.ATLAS_MAIN, {
      jobKind: 'onboarding',
      settings: { repoConventions: PROFILE },
    });
    // Everything before the envelope is byte-identical to the no-conventions prompt.
    expect(withConv.startsWith(baseline)).toBe(true);
    expect(withConv.trimEnd().endsWith(PROFILE.body)).toBe(true);
  });
});

describe('conventions.group — notice-house-style-drift affordance', () => {
  const MARK = 'NOTICING THE HOUSE STYLE SHOULD CHANGE';
  const conv = { settings: { repoConventions: PROFILE } };

  it('appears for the build brain (feature/bugfix) when a profile is attached', () => {
    expect(renderAgentPrompt(Agent.ATLAS_MAIN, { jobKind: 'feature', ...conv })).toContain(MARK);
    expect(renderAgentPrompt(Agent.ATLAS_MAIN, { jobKind: 'bugfix', ...conv })).toContain(MARK);
  });

  it('is absent when no profile is attached (nothing to notice)', () => {
    expect(renderAgentPrompt(Agent.ATLAS_MAIN, { jobKind: 'feature' })).not.toContain(MARK);
  });

  it('is absent for onboarding + review turns (only the build brain proposes profile changes)', () => {
    expect(renderAgentPrompt(Agent.ATLAS_MAIN, { jobKind: 'onboarding', ...conv })).not.toContain(MARK);
    expect(renderAgentPrompt(Agent.ATLAS_MAIN, { jobKind: 'review', ...conv })).not.toContain(MARK);
  });

  it('never reaches workers or advisory subagents', () => {
    for (const a of [Agent.WORKER, Agent.FAN_OUT, Agent.REVIEW_AGENT, Agent.EXPLORE]) {
      expect(renderAgentPrompt(a, conv)).not.toContain(MARK);
    }
  });
});
