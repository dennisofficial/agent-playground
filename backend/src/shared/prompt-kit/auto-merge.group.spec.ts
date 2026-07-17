import { describe, expect, it } from 'vitest';
import { Agent } from './system/agent';
import { renderAgentPrompt } from './system/assemble';
import { hasAutoMerge } from './system/conditions';

const MARKER = 'AUTO-MERGE MODE';

describe('hasAutoMerge', () => {
  it('is true only when settings.autoMerge === true', () => {
    expect(hasAutoMerge({ settings: { autoMerge: true } })).toBe(true);
    expect(hasAutoMerge({ settings: { autoMerge: false } })).toBe(false);
    expect(hasAutoMerge({ settings: {} })).toBe(false);
    expect(hasAutoMerge({})).toBe(false);
  });
});

describe('auto-merge.group — auto-merge-mode announcement', () => {
  it('injects the marker for ATLAS_MAIN when autoMerge is true', () => {
    const out = renderAgentPrompt(Agent.PLANNING, {
      settings: { autoMerge: true },
    });
    expect(out).toContain(MARKER);
  });

  it('emits NOTHING (byte-identical) for ATLAS_MAIN when autoMerge is false', () => {
    const baseline = renderAgentPrompt(Agent.PLANNING);
    const out = renderAgentPrompt(Agent.PLANNING, {
      settings: { autoMerge: false },
    });
    expect(out).not.toContain(MARKER);
    expect(out).toBe(baseline);
  });

  it('is absent when autoMerge is unset (no settings at all)', () => {
    const out = renderAgentPrompt(Agent.PLANNING);
    expect(out).not.toContain(MARKER);
  });

  it('never reaches a worker agent, even with autoMerge ON', () => {
    const out = renderAgentPrompt(Agent.WORKER, {
      settings: { autoMerge: true },
    });
    expect(out).not.toContain(MARKER);
  });

  it('tells the brain a green, mergeable PR merges itself with no human at the final gate', () => {
    const out = renderAgentPrompt(Agent.PLANNING, {
      settings: { autoMerge: true },
    });
    expect(out).toMatch(/merges? .*without a human/i);
  });
});
