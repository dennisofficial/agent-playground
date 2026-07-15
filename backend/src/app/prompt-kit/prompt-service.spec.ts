import { createHash } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { PromptService } from './prompt.service';
import { Agent } from './system/agent';
import {
  Fragment,
  FragmentGroup,
  getFragmentMetaMap,
} from './system/fragment.decorator';
import {
  loadFragmentsFromInstances,
  renderAgentPrompt,
  validateFragments,
} from './system/assemble';

/**
 * The fragment-library assembler, exercised on the brain (`ATLAS_MAIN`). The brain is now assembled ONLY from
 * fragments (its legacy mega-body is deleted), so these assert the assembly is structurally correct: the right
 * fragments in the right order, onboarding vs normal gated by `jobKind`, the conditional operator block, and the
 * fail-loud validation. Rendering is pure (`renderAgentPrompt`); `PromptService` is the boot-loud DI facade.
 */
describe('renderAgentPrompt — brain assembly (ATLAS_MAIN)', () => {
  it('assembles a substantial brain prompt that opens with the identity for each job kind', () => {
    for (const jobKind of [
      'feature',
      'bugfix',
      'event',
      'onboarding',
    ] as const) {
      const out = renderAgentPrompt(Agent.PLANNING, { jobKind });
      expect(out.length, `jobKind=${jobKind}`).toBeGreaterThan(10_000);
      expect(out.startsWith('You are Atlas'), `jobKind=${jobKind}`).toBe(true);
    }
  });

  it('carries the job-kind block + behavioral tail, in that order, for a feature job', () => {
    const out = renderAgentPrompt(Agent.PLANNING, { jobKind: 'feature' });
    const identityAt = out.indexOf(
      'You are Atlas, an autonomous software-engineering orchestrator',
    );
    const jobKindAt = out.indexOf('JOB KIND — FEATURE');
    const baselineAt = out.indexOf('BASELINE THE CURRENT BEHAVIOR');
    const liveValAt = out.indexOf('PROVE IT BY RUNNING IT');
    const spikeAt = out.indexOf('SPIKE BEFORE YOU COMMIT');
    expect(identityAt).toBe(0); // identity leads
    expect(jobKindAt).toBeGreaterThan(identityAt);
    expect(baselineAt).toBeGreaterThan(jobKindAt); // tail after the job-kind block
    expect(liveValAt).toBeGreaterThan(baselineAt); // author-live-validation after baseline
    expect(spikeAt).toBeGreaterThan(liveValAt); // ...and before spike
  });

  it('onboarding vs feature select DIFFERENT fragments (jobKind is a condition, not an agent)', () => {
    const feature = renderAgentPrompt(Agent.PLANNING, { jobKind: 'feature' });
    const onboarding = renderAgentPrompt(Agent.PLANNING, {
      jobKind: 'onboarding',
    });

    // feature-only (normal-brain) content
    expect(feature).toContain('WHY YOU GRILL');
    expect(feature).toContain('FULL PATH — review_plan then propose_plan');
    expect(feature).toContain('JOB KIND — FEATURE');
    expect(onboarding).not.toContain('WHY YOU GRILL');
    expect(onboarding).not.toContain(
      'FULL PATH — review_plan then propose_plan',
    );
    expect(onboarding).not.toContain('JOB KIND —');

    // onboarding-only content
    expect(onboarding).toContain('onboarding a newly-connected repository');
    expect(onboarding).toContain('FLEET INVENTORY');
    expect(onboarding).toContain(
      'FINISH — only when the FULL fleet inventory is GREEN',
    );
    // the live-accessibility procedure is onboarding-only (build brains carry PUBLIC PREVIEW URLS instead)
    expect(onboarding).toContain('LIVE-SERVICE ACCESSIBILITY');
    expect(feature).not.toContain('onboarding a newly-connected repository');
    expect(feature).not.toContain('FLEET INVENTORY');
    expect(feature).not.toContain('LIVE-SERVICE ACCESSIBILITY');

    // the behavioral tail is shared (no jobKind condition)
    for (const out of [feature, onboarding])
      expect(out).toContain('SPIKE BEFORE YOU COMMIT');
  });

  it('carries the UI-preview + context-link guidance on build brains, not onboarding', () => {
    const feature = renderAgentPrompt(Agent.PLANNING, { jobKind: 'feature' });
    const onboarding = renderAgentPrompt(Agent.PLANNING, {
      jobKind: 'onboarding',
    });
    expect(feature).toContain('UI PREVIEW BY DEFAULT');
    expect(feature).toContain('REFERENCE /context FILES AS CLICKABLE LINKS');
    expect(onboarding).not.toContain('UI PREVIEW BY DEFAULT'); // isBuildBrain gate
  });

  it('appends the operator/org instructions ONLY when set (and never otherwise)', () => {
    const marker = 'OPERATOR / ORG INSTRUCTIONS';
    const custom = 'Always prefer pnpm over npm in this workspace.';

    const without = renderAgentPrompt(Agent.PLANNING, { jobKind: 'feature' });
    expect(without).not.toContain(marker);

    const blank = renderAgentPrompt(Agent.PLANNING, {
      jobKind: 'feature',
      settings: { userOrgInstructions: '   ' },
    });
    expect(blank).not.toContain(marker); // whitespace-only is treated as absent

    const withInstr = renderAgentPrompt(Agent.PLANNING, {
      jobKind: 'feature',
      settings: { userOrgInstructions: custom },
    });
    expect(withInstr).toContain(marker);
    expect(withInstr).toContain(custom);
    // appended at the very end (after the behavioral tail) and byte-identical prefix to the no-settings output
    expect(withInstr.startsWith(without)).toBe(true);
    expect(withInstr.trimEnd().endsWith(custom)).toBe(true);
  });
});

/**
 * Byte-parity guard for the ATLAS_MAIN → PLANNING split (Thread 1 of the "explode the brain" plan). Every
 * fragment-audience change in that split was ADDITIVE ONLY — PLANNING was never removed from a fragment,
 * and no fragment's TEXT was edited — so `Agent.PLANNING`'s assembled prompt must be byte-identical to
 * `Agent.ATLAS_MAIN`'s pre-split output. These sha256 hashes were captured from the pre-split commit
 * (`c4d27b77`, the base of the split) by rendering `renderAgentPrompt(Agent.ATLAS_MAIN, { jobKind })` for
 * each kind — a genuine golden snapshot, not a guess. A failure here means PLANNING's prompt drifted from
 * the legacy brain; that's either a real regression or an intentional change that needs a fresh snapshot.
 */
describe('renderAgentPrompt(Agent.PLANNING) — byte-parity with pre-split ATLAS_MAIN', () => {
  const PRE_SPLIT_SHA256: Record<string, string> = {
    feature:
      '9f91cb4ea0bb9c71d506de07cbd91572478d0336a431d819dfec0f5c6fa128ae',
    bugfix: '273740cbfad1c562a81c3eab57f7e88fe2a02afc22937fd590131337a2c9563b',
    onboarding:
      'f205e216f00f2c387b817fb6db7daa9c82a897ec900cac82df3036d9e83720bf',
    review: '5f59250d21b2ee47a5c708e3d76c58efbef307f8946550f702b3e1895f317898',
  };

  it.each(['feature', 'bugfix', 'onboarding', 'review'] as const)(
    'jobKind=%s renders byte-identical to the pre-split ATLAS_MAIN snapshot',
    (jobKind) => {
      const out = renderAgentPrompt(Agent.PLANNING, { jobKind });
      const sha256 = createHash('sha256').update(out).digest('hex');
      expect(sha256).toBe(PRE_SPLIT_SHA256[jobKind]);
    },
  );
});

describe('PromptService — DI facade boots + validates', () => {
  it('resolves + primes without throwing (the real fragment set is valid)', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [PromptService],
    }).compile();
    await moduleRef.init(); // fires onModuleInit → primeFragments (boot-loud validation)
    const prompts = moduleRef.get(PromptService);
    expect(
      prompts.generate(Agent.PLANNING, { jobKind: 'feature' }).length,
    ).toBeGreaterThan(10_000);
  });
});

describe('validateFragments — fails loudly', () => {
  it('throws on a duplicate order within an agent', () => {
    @FragmentGroup()
    class ClashingGroup {
      @Fragment({ usedBy: [Agent.PLANNING], order: 5000 })
      a(): string {
        return 'A';
      }

      @Fragment({ usedBy: [Agent.PLANNING], order: 5000 })
      b(): string {
        return 'B';
      }
    }
    const instance = new ClashingGroup();
    // sanity: the @Fragment methods were recorded on the prototype
    expect(
      Object.keys(getFragmentMetaMap(Object.getPrototypeOf(instance))),
    ).toEqual(['a', 'b']);
    expect(() =>
      validateFragments(loadFragmentsFromInstances([instance])),
    ).toThrow(/duplicate order 5000 for agent/);
  });
});
