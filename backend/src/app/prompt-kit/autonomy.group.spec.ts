import { describe, expect, it } from 'vitest';
import { Agent } from './agent';
import { renderAgentPrompt } from './assemble';

/**
 * The autonomy fragment (`autonomy.group`) — announces AUTONOMOUS MODE to the build brain when the job's
 * `autoApprove` setting is ON, and vanishes (byte-identical prompt) when it is off — the no-misfire invariant.
 */
const MARKER = 'AUTONOMOUS MODE';

describe('autonomy.group — autonomous-mode announcement', () => {
  it('injects the marker for ATLAS_MAIN when autoApprove is ON', () => {
    const out = renderAgentPrompt(Agent.ATLAS_MAIN, { settings: { autoApprove: true } });
    expect(out).toContain(MARKER);
  });

  it('emits NOTHING (byte-identical) for ATLAS_MAIN when autoApprove is OFF', () => {
    const baseline = renderAgentPrompt(Agent.ATLAS_MAIN);
    const out = renderAgentPrompt(Agent.ATLAS_MAIN, { settings: { autoApprove: false } });
    expect(out).not.toContain(MARKER);
    // The no-misfire invariant: autoApprove off ⇒ exactly today's prompt.
    expect(out).toBe(baseline);
  });

  it('is absent when autoApprove is unset (no settings at all)', () => {
    const out = renderAgentPrompt(Agent.ATLAS_MAIN);
    expect(out).not.toContain(MARKER);
  });

  it('never reaches a worker agent, even with autoApprove ON', () => {
    const out = renderAgentPrompt(Agent.WORKER, { settings: { autoApprove: true } });
    expect(out).not.toContain(MARKER);
  });
});
