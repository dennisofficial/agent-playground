import { describe, expect, it } from 'vitest';
import { postBuildGateSeed } from './post-build-gate';

describe('turns / post-build-gate', () => {
  describe('postBuildGateSeed', () => {
    it('offers a preview and tells the session not to open the PR or re-plan', () => {
      const out = postBuildGateSeed();
      expect(out).toContain('preview');
      expect(out).toContain('Do NOT open the PR');
      expect(out).toMatch(/do not re-plan/i);
    });

    it('points the session at the durable reconstruction sources, not a live transcript', () => {
      const out = postBuildGateSeed();
      expect(out).toContain('/context/specs/plan.md');
      expect(out).toContain('/context/evidence/');
      expect(out).toContain('git diff origin/<base>...HEAD');
    });

    it('asks for exactly one short operator-facing summary (1-3 bullets)', () => {
      const out = postBuildGateSeed();
      expect(out).toContain('ONE short message');
      expect(out).toContain('1–3 bullet');
    });

    it('carries no grilling/plan-authoring language (this is a task body, not a planning turn)', () => {
      const out = postBuildGateSeed();
      expect(out).not.toContain('propose_plan');
      expect(out).not.toContain('GRILLING PROTOCOL');
      expect(out).not.toContain('__ask_question');
    });
  });
});
