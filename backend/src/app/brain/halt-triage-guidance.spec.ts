import { describe, expect, it } from 'vitest';
import { haltTriageGuidance } from './agent-session-manager.service';

/**
 * The retrieve-vs-author safety doctrine (the brain's ONE autonomous shot at a halted thread is RETRIEVAL,
 * never AUTHORING). These lock the load-bearing property: on a genuine design gap the brain is told it may
 * ONLY clear by citing an existing answer, and must ASK the operator when it would have to CHOOSE — it must
 * never be told to just decide. A regression here would let Atlas invent product decisions on Dennis's behalf.
 */
describe('haltTriageGuidance (retrieve-vs-author)', () => {
  const text = (reason?: 'question' | 'needs_env' | 'decision' | 'unverified') =>
    haltTriageGuidance(reason).join('\n');

  it('needs_env → verify the premise first (is the access actually missing?)', () => {
    const g = text('needs_env');
    expect(g).toMatch(/verify the block is real/i);
    expect(g).toMatch(/cite what you verified/i);
    expect(g).toMatch(/halted\s+thread's lane/i);
    expect(g).toMatch(/only if the access is GENUINELY missing/i);
  });

  for (const reason of ['question', 'decision'] as const) {
    it(`${reason} → retrieve-or-escalate, and NEVER author a new decision`, () => {
      const g = text(reason);
      // May clear ONLY by retrieving an existing answer and citing it.
      expect(g).toMatch(/already exists/i);
      expect(g).toMatch(/CITE that source/);
      // The hard prohibition — must not author, must ask when it would have to choose.
      expect(g).toMatch(/may NOT AUTHOR/i);
      expect(g).toMatch(/ask_question/);
      expect(g).toMatch(/choosing between defensible options/i);
    });
  }

  it('no self-reported reason (incomplete/failed) → the generic fix-or-escalate framing', () => {
    const g = text(undefined);
    expect(g).toMatch(/halted thread's lane/);
    expect(g).not.toMatch(/may NOT AUTHOR/i); // the author prohibition is design-gap-specific
  });

  it('every branch keeps the headless-driver caveat', () => {
    for (const reason of [undefined, 'needs_env', 'question', 'decision'] as const) {
      expect(text(reason)).toMatch(/build driver is headless/i);
      expect(text(reason)).toMatch(/thread's own lane/i);
    }
  });

  it('every branch leads with the forensic "read the transcript via atlas-tx" orientation', () => {
    for (const reason of [undefined, 'needs_env', 'question', 'decision'] as const) {
      const g = text(reason);
      expect(g).toMatch(/READ THE HALTED LANE'S OWN TRANSCRIPT/);
      expect(g).toMatch(/atlas-tx show <sessionId>/);
      // The belief-vs-reality forensic framing the reference screenshots want.
      expect(g).toMatch(/BELIEVE vs\. what was TRUE/);
    }
  });
});
