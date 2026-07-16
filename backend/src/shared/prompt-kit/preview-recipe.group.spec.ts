import { describe, expect, it } from 'vitest';
import { Agent } from './system/agent';
import { renderAgentPrompt } from './system/assemble';

/**
 * The repo's saved preview recipe reaches the WORKER orchestrator (rendered server-side) and the `validate`
 * subagent (re-rendered in-sandbox via `applyPerRunCtxToAgents`) as READ-ONLY standing context — never
 * anywhere else, and never when absent (byte-identical to today).
 */
const MARKER = 'UNIQUEMARKER123';

describe('preview recipe — WORKER + validate', () => {
  it('WORKER prompt contains the recipe when previewInstructions is set', () => {
    const out = renderAgentPrompt(Agent.WORKER, {
      previewInstructions: MARKER,
      turnPhase: 'batch',
    });
    expect(out).toContain(MARKER);
    expect(out).toContain('READ-ONLY');
  });

  it('validate prompt contains the recipe when previewInstructions is set', () => {
    const out = renderAgentPrompt(Agent.VALIDATE, {
      previewInstructions: MARKER,
    });
    expect(out).toContain(MARKER);
    expect(out).toContain('READ-ONLY');
  });

  it('WORKER prompt is byte-identical to the baseline when previewInstructions is absent', () => {
    const baseline = renderAgentPrompt(Agent.WORKER, { turnPhase: 'batch' });
    const out = renderAgentPrompt(Agent.WORKER, {
      turnPhase: 'batch',
      previewInstructions: null,
    });
    expect(out).not.toContain(MARKER);
    expect(out).toBe(baseline);
  });

  it('validate prompt is byte-identical to the baseline when previewInstructions is absent', () => {
    const baseline = renderAgentPrompt(Agent.VALIDATE);
    const out = renderAgentPrompt(Agent.VALIDATE, {
      previewInstructions: null,
    });
    expect(out).not.toContain(MARKER);
    expect(out).toBe(baseline);
  });

  it('never reaches other build-facing agents', () => {
    for (const agent of [
      Agent.PLANNING,
      Agent.FAN_OUT,
      Agent.REVIEW_AGENT,
      Agent.EXPLORE,
    ]) {
      expect(
        renderAgentPrompt(agent, { previewInstructions: MARKER }),
      ).not.toContain(MARKER);
    }
  });
});
