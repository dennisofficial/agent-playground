import { describe, expect, it } from 'vitest';
import { Agent } from './system/agent';
import { renderAgentPrompt } from './system/assemble';

/**
 * The autonomy fragment (`autonomy.group`) — announces AUTONOMOUS MODE to the build brain when the job's
 * `autoApproveMode` setting is not `'off'`, and vanishes (byte-identical prompt) when it is off/unset — the
 * no-misfire invariant. The copy itself is derived from WHICH gate(s) the mode covers.
 */
const MARKER = 'AUTONOMOUS MODE';

describe('autonomy.group — autonomous-mode announcement', () => {
  it.each(['plan', 'ship', 'both'] as const)(
    'injects the marker for ATLAS_MAIN when autoApproveMode is %s',
    (mode) => {
      const out = renderAgentPrompt(Agent.ATLAS_MAIN, {
        settings: { autoApproveMode: mode },
      });
      expect(out).toContain(MARKER);
    },
  );

  it('emits NOTHING (byte-identical) for ATLAS_MAIN when autoApproveMode is off', () => {
    const baseline = renderAgentPrompt(Agent.ATLAS_MAIN);
    const out = renderAgentPrompt(Agent.ATLAS_MAIN, {
      settings: { autoApproveMode: 'off' },
    });
    expect(out).not.toContain(MARKER);
    // The no-misfire invariant: mode off ⇒ exactly today's prompt.
    expect(out).toBe(baseline);
  });

  it('is absent when autoApproveMode is unset (no settings at all)', () => {
    const out = renderAgentPrompt(Agent.ATLAS_MAIN);
    expect(out).not.toContain(MARKER);
  });

  it('never reaches a worker agent, even with autoApproveMode ON', () => {
    const out = renderAgentPrompt(Agent.WORKER, {
      settings: { autoApproveMode: 'both' },
    });
    expect(out).not.toContain(MARKER);
  });

  it('"both" mentions BOTH the plan-approval and ship-review gates advancing without a human', () => {
    const out = renderAgentPrompt(Agent.ATLAS_MAIN, {
      settings: { autoApproveMode: 'both' },
    });
    expect(out).toContain('plan-approval and ship-review gates advance');
    expect(out).toContain('WITHOUT a human');
  });

  it('"plan" uses the plan-gate-only header and says the ship-review gate is UNCHANGED', () => {
    const out = renderAgentPrompt(Agent.ATLAS_MAIN, {
      settings: { autoApproveMode: 'plan' },
    });
    expect(out).toContain('AUTONOMOUS MODE (plan gate only)');
    expect(out).toContain('ship-review gate is UNCHANGED');
  });

  it('"ship" uses the ship-gate-only header and says the plan-approval gate is UNCHANGED', () => {
    const out = renderAgentPrompt(Agent.ATLAS_MAIN, {
      settings: { autoApproveMode: 'ship' },
    });
    expect(out).toContain('AUTONOMOUS MODE (ship gate only)');
    expect(out).toContain('plan-approval gate is UNCHANGED');
  });

  it('the copy differs across plan / ship / both (distinct, not shared boilerplate)', () => {
    const plan = renderAgentPrompt(Agent.ATLAS_MAIN, {
      settings: { autoApproveMode: 'plan' },
    });
    const ship = renderAgentPrompt(Agent.ATLAS_MAIN, {
      settings: { autoApproveMode: 'ship' },
    });
    const both = renderAgentPrompt(Agent.ATLAS_MAIN, {
      settings: { autoApproveMode: 'both' },
    });
    expect(plan).not.toBe(ship);
    expect(plan).not.toBe(both);
    expect(ship).not.toBe(both);
  });
});
