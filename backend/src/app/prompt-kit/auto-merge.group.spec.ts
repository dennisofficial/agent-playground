import { describe, expect, it } from 'vitest';
import { Agent } from './system/agent';
import { renderAgentPrompt } from './system/assemble';
import { hasAutoMerge } from './system/conditions';

/**
 * The auto-merge fragment (`auto-merge.group`) — announces AUTO-MERGE MODE to the build brain when the
 * job's `autoMerge` setting is on, and vanishes (byte-identical prompt) when it is off/unset — the
 * no-misfire invariant.
 */
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
    const out = renderAgentPrompt(Agent.ATLAS_MAIN, { settings: { autoMerge: true } });
    expect(out).toContain(MARKER);
  });

  it('emits NOTHING (byte-identical) for ATLAS_MAIN when autoMerge is false', () => {
    const baseline = renderAgentPrompt(Agent.ATLAS_MAIN);
    const out = renderAgentPrompt(Agent.ATLAS_MAIN, { settings: { autoMerge: false } });
    expect(out).not.toContain(MARKER);
    // The no-misfire invariant: autoMerge off ⇒ exactly today's prompt.
    expect(out).toBe(baseline);
  });

  it('is absent when autoMerge is unset (no settings at all)', () => {
    const out = renderAgentPrompt(Agent.ATLAS_MAIN);
    expect(out).not.toContain(MARKER);
  });

  it('never reaches a worker agent, even with autoMerge ON', () => {
    const out = renderAgentPrompt(Agent.WORKER, { settings: { autoMerge: true } });
    expect(out).not.toContain(MARKER);
  });

  it('tells the brain a green, mergeable PR merges itself with no human at the final gate', () => {
    const out = renderAgentPrompt(Agent.ATLAS_MAIN, { settings: { autoMerge: true } });
    expect(out).toMatch(/merges? .*without a human/i);
  });
});
