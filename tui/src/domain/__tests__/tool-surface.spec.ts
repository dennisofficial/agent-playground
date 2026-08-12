import { describe, expect, it } from 'bun:test';
import { EPhaseKind, EThreadRole } from '../../generated/prisma/enums.js';
import {
  EToolTier,
  visibleTools,
  type ToolAudience,
  type ToolGate,
} from '../tool-surface.js';

const AUDIENCE: ToolAudience = {
  tier: EToolTier.thread,
  role: EThreadRole.builder,
  phase: EPhaseKind.build,
};

function gate(name: string, extra: Partial<ToolGate> = {}): ToolGate {
  return { name, tiers: [EToolTier.thread], ...extra };
}

describe('visibleTools', () => {
  it('is a filter over ONE list — the surface is never assembled per role', () => {
    const tools = [gate('a'), gate('b'), gate('c')];
    expect(visibleTools({ tools, ...AUDIENCE }).map((t) => t.name)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('drops a tool the tier does not hold, rather than offering one that would refuse', () => {
    const tools = [
      gate('advance_thread'),
      gate('rotate', { tiers: [EToolTier.thread, EToolTier.teammate] }),
    ];
    const seen = visibleTools({
      tools,
      ...AUDIENCE,
      tier: EToolTier.teammate,
    });
    // A teammate never moves Atlas's structure — it holds the session-level verb and nothing else.
    expect(seen.map((t) => t.name)).toEqual(['rotate']);
  });

  it('drops a tool with nothing legal to offer in this phase', () => {
    const tools = [
      gate('advance_phase', {
        offeredIn: (audience) => audience.phase !== EPhaseKind.ci,
      }),
    ];
    expect(visibleTools({ tools, ...AUDIENCE }).length).toBe(1);
    expect(
      visibleTools({ tools, ...AUDIENCE, phase: EPhaseKind.ci }).length,
    ).toBe(0);
  });

  it('hands the whole audience to the gate, so a rule may read the role as well as the phase', () => {
    const seen: ToolAudience[] = [];
    visibleTools({
      tools: [
        gate('x', {
          offeredIn: (audience) => {
            seen.push(audience);
            return true;
          },
        }),
      ],
      ...AUDIENCE,
    });
    expect(seen).toEqual([AUDIENCE]);
  });
});
