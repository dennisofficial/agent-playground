import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { PromptService } from './prompt.service';
import { Agent } from './agent';
import { Fragment, FragmentGroup, getFragmentMetaMap } from './fragment.decorator';
import { loadFragmentsFromInstances, renderAgentPrompt, validateFragments } from './assemble';

/**
 * The fragment-library assembler, exercised on the brain (`ATLAS_MAIN`). The brain is now assembled ONLY from
 * fragments (its legacy mega-body is deleted), so these assert the assembly is structurally correct: the right
 * fragments in the right order, onboarding vs normal gated by `jobKind`, the conditional operator block, and the
 * fail-loud validation. Rendering is pure (`renderAgentPrompt`); `PromptService` is the boot-loud DI facade.
 */
describe('renderAgentPrompt — brain assembly (ATLAS_MAIN)', () => {
  it('assembles a substantial brain prompt that opens with the identity for each job kind', () => {
    for (const jobKind of ['feature', 'bugfix', 'event', 'onboarding'] as const) {
      const out = renderAgentPrompt(Agent.ATLAS_MAIN, { jobKind });
      expect(out.length, `jobKind=${jobKind}`).toBeGreaterThan(10_000);
      expect(out.startsWith('You are Atlas'), `jobKind=${jobKind}`).toBe(true);
    }
  });

  it('carries the job-kind block + behavioral tail, in that order, for a feature job', () => {
    const out = renderAgentPrompt(Agent.ATLAS_MAIN, { jobKind: 'feature' });
    const identityAt = out.indexOf('You are Atlas, an autonomous software-engineering orchestrator');
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
    const feature = renderAgentPrompt(Agent.ATLAS_MAIN, { jobKind: 'feature' });
    const onboarding = renderAgentPrompt(Agent.ATLAS_MAIN, { jobKind: 'onboarding' });

    // feature-only (normal-brain) content
    expect(feature).toContain('WHY YOU GRILL');
    expect(feature).toContain('FULL PATH — review_plan then propose_plan');
    expect(feature).toContain('JOB KIND — FEATURE');
    expect(onboarding).not.toContain('WHY YOU GRILL');
    expect(onboarding).not.toContain('FULL PATH — review_plan then propose_plan');
    expect(onboarding).not.toContain('JOB KIND —');

    // onboarding-only content
    expect(onboarding).toContain('onboarding a newly-connected repository');
    expect(onboarding).toContain('FLEET INVENTORY');
    expect(onboarding).toContain('FINISH — only when the FULL fleet inventory is GREEN');
    expect(feature).not.toContain('onboarding a newly-connected repository');
    expect(feature).not.toContain('FLEET INVENTORY');

    // the behavioral tail is shared (no jobKind condition)
    for (const out of [feature, onboarding]) expect(out).toContain('SPIKE BEFORE YOU COMMIT');
  });

  it('appends the operator/org instructions ONLY when set (and never otherwise)', () => {
    const marker = 'OPERATOR / ORG INSTRUCTIONS';
    const custom = 'Always prefer pnpm over npm in this workspace.';

    const without = renderAgentPrompt(Agent.ATLAS_MAIN, { jobKind: 'feature' });
    expect(without).not.toContain(marker);

    const blank = renderAgentPrompt(Agent.ATLAS_MAIN, {
      jobKind: 'feature',
      settings: { userOrgInstructions: '   ' },
    });
    expect(blank).not.toContain(marker); // whitespace-only is treated as absent

    const withInstr = renderAgentPrompt(Agent.ATLAS_MAIN, {
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

describe('PromptService — DI facade boots + validates', () => {
  it('resolves + primes without throwing (the real fragment set is valid)', async () => {
    const moduleRef = await Test.createTestingModule({ providers: [PromptService] }).compile();
    await moduleRef.init(); // fires onModuleInit → primeFragments (boot-loud validation)
    const prompts = moduleRef.get(PromptService);
    expect(prompts.generate(Agent.ATLAS_MAIN, { jobKind: 'feature' }).length).toBeGreaterThan(10_000);
  });
});

describe('validateFragments — fails loudly', () => {
  it('throws on a duplicate order within an agent', () => {
    @FragmentGroup()
    class ClashingGroup {
      @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 5000 })
      a(): string {
        return 'A';
      }

      @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 5000 })
      b(): string {
        return 'B';
      }
    }
    const instance = new ClashingGroup();
    // sanity: the @Fragment methods were recorded on the prototype
    expect(Object.keys(getFragmentMetaMap(Object.getPrototypeOf(instance)))).toEqual(['a', 'b']);
    expect(() => validateFragments(loadFragmentsFromInstances([instance]))).toThrow(
      /duplicate order 5000 for agent/,
    );
  });
});
