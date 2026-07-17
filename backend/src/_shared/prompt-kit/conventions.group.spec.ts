import { describe, expect, it } from 'vitest';
import { Agent } from './system/agent';
import { renderAgentPrompt } from './system/assemble';

const MARKER = 'REPO HOUSE CONVENTIONS';
const PROFILE = {
  name: 'NestJS + Next + shared',
  body: 'Use a shared/ contract dir for all DTOs.',
};

const BUILD_FACING: Agent[] = [
  Agent.PLANNING,
  Agent.WORKER,
  Agent.FAN_OUT,
  Agent.REVIEW_AGENT,
  Agent.META_PLAN_REVIEW,
  Agent.AUTOFIX_REVIEW,
  Agent.AUTOFIX_FIX,
];

const EXCLUDED: Agent[] = [Agent.EXPLORE, Agent.DOCS, Agent.DEBUG, Agent.TEST, Agent.VALIDATE];

describe('conventions.group — repo house-style envelope', () => {
  it.each(BUILD_FACING)(
    'injects the envelope + body for %s when a profile is attached',
    (agent) => {
      const out = renderAgentPrompt(agent, {
        settings: { repoConventions: PROFILE },
      });
      expect(out).toContain(MARKER);
      expect(out).toContain(PROFILE.name);
      expect(out).toContain(PROFILE.body);
    },
  );

  it.each(BUILD_FACING)(
    'emits NOTHING (byte-identical) for %s when no profile is attached',
    (agent) => {
      const baseline = renderAgentPrompt(agent);
      const nullish = renderAgentPrompt(agent, {
        settings: { repoConventions: null },
      });
      const blank = renderAgentPrompt(agent, {
        settings: { repoConventions: { name: 'x', body: '   ' } },
      });
      expect(nullish).not.toContain(MARKER);
      expect(blank).not.toContain(MARKER); // whitespace-only body is treated as absent
      expect(nullish).toBe(baseline);
      expect(blank).toBe(baseline);
    },
  );

  it.each(EXCLUDED)('never injects the envelope for the advisory subagent %s', (agent) => {
    const out = renderAgentPrompt(agent, {
      settings: { repoConventions: PROFILE },
    });
    expect(out).not.toContain(MARKER);
  });

  it('appends the envelope at the tail (operator-layer), not the head', () => {
    const baseline = renderAgentPrompt(Agent.PLANNING, {
      jobKind: 'onboarding',
    });
    const withConv = renderAgentPrompt(Agent.PLANNING, {
      jobKind: 'onboarding',
      settings: { repoConventions: PROFILE },
    });
    expect(withConv.startsWith(baseline)).toBe(true);
    expect(withConv.trimEnd().endsWith(PROFILE.body)).toBe(true);
  });
});

describe('conventions.group — notice-house-style-drift affordance', () => {
  const MARK = 'NOTICING THE HOUSE STYLE SHOULD CHANGE';
  const conv = { settings: { repoConventions: PROFILE } };

  it('appears for the build brain (feature/bugfix) when a profile is attached', () => {
    expect(renderAgentPrompt(Agent.PLANNING, { jobKind: 'feature', ...conv })).toContain(MARK);
    expect(renderAgentPrompt(Agent.PLANNING, { jobKind: 'bugfix', ...conv })).toContain(MARK);
  });

  it('is absent when no profile is attached (nothing to notice)', () => {
    expect(renderAgentPrompt(Agent.PLANNING, { jobKind: 'feature' })).not.toContain(MARK);
  });

  it('is absent for onboarding + review turns (only the build brain proposes profile changes)', () => {
    expect(renderAgentPrompt(Agent.PLANNING, { jobKind: 'onboarding', ...conv })).not.toContain(
      MARK,
    );
    expect(renderAgentPrompt(Agent.PLANNING, { jobKind: 'review', ...conv })).not.toContain(MARK);
  });

  it('never reaches workers or advisory subagents', () => {
    for (const a of [Agent.WORKER, Agent.FAN_OUT, Agent.REVIEW_AGENT, Agent.EXPLORE]) {
      expect(renderAgentPrompt(a, conv)).not.toContain(MARK);
    }
  });
});
