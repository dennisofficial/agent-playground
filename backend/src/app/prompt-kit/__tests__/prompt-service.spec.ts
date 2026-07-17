import { Test } from '@nestjs/testing';
import { Agent } from '@shared/prompt-kit/system/agent';
import {
  loadFragmentsFromInstances,
  renderAgentPrompt,
  validateFragments,
} from '@shared/prompt-kit/system/assemble';
import {
  Fragment,
  FragmentGroup,
  getFragmentMetaMap,
} from '@shared/prompt-kit/system/fragment.decorator';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PromptService } from '../prompt.service';

/**
 * The fragment-library assembler, exercised on the brain (`ATLAS_MAIN`). The brain is now assembled ONLY from
 * fragments (its legacy mega-body is deleted), so these assert the assembly is structurally correct: the right
 * fragments in the right order, onboarding vs normal gated by `jobKind`, the conditional operator block, and the
 * fail-loud validation. Rendering is pure (`renderAgentPrompt`); `PromptService` is the boot-loud DI facade.
 */
describe('renderAgentPrompt — brain assembly (ATLAS_MAIN)', () => {
  it('assembles a substantial brain prompt that opens with the identity for each job kind', () => {
    for (const jobKind of ['feature', 'bugfix', 'event', 'onboarding'] as const) {
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
    expect(onboarding).not.toContain('FULL PATH — review_plan then propose_plan');
    expect(onboarding).not.toContain('JOB KIND —');

    // onboarding-only content
    expect(onboarding).toContain('onboarding a newly-connected repository');
    expect(onboarding).toContain('FLEET INVENTORY');
    expect(onboarding).toContain('FINISH — only when the FULL fleet inventory is GREEN');
    // the live-accessibility procedure is onboarding-only (build brains carry PUBLIC PREVIEW URLS instead)
    expect(onboarding).toContain('LIVE-SERVICE ACCESSIBILITY');
    expect(feature).not.toContain('onboarding a newly-connected repository');
    expect(feature).not.toContain('FLEET INVENTORY');
    expect(feature).not.toContain('LIVE-SERVICE ACCESSIBILITY');

    // the behavioral tail is shared (no jobKind condition)
    for (const out of [feature, onboarding]) expect(out).toContain('SPIKE BEFORE YOU COMMIT');
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
 * and no fragment's TEXT was edited — so `Agent.PLANNING`'s assembled prompt must be byte-identical to the
 * legacy monolithic brain's output for the SAME fragment set.
 *
 * SNAPSHOT REFRESHED at the merge of this branch with `main` (`df8f77e8`). The original golden was captured
 * from the split base (`c4d27b77`); since then `main` legitimately ADVANCED the brain prompt (task-list
 * tools, forget/update_memory, session-limit prose, …), all of which flow into PLANNING because the split
 * kept PLANNING in every fragment those changes touch. The refresh was verified NOT to be a merge
 * regression: the merged PLANNING prompt (a) still contains the planning core (grilling / propose_plan) and
 * every `main` addition (LIVE TASK LIST, task_create, forget, update_memory), and (b) contains ZERO
 * ship-persona text (`postBuildTools`/`ciTools`/`postShipContext`/`autonomyPostShip` are gated to
 * POST_BUILD/CI and never leak into PLANNING). A failure here means PLANNING's prompt drifted from the
 * legacy brain; that's either a real regression or an intentional change that needs a fresh snapshot.
 *
 * SNAPSHOT REFRESHED AGAIN for the universal DIAGRAMS-ARE-MERMAID rule (`behavioral.group`'s `diagramFormat`,
 * fragment `DIAGRAM_FORMAT_NOTE`): it is deliberately `usedBy: ENGINEERING_STAGES`, which includes PLANNING,
 * so PLANNING's prompt legitimately grew by that one ungated behavioral note — an intentional additive
 * change, refreshed here rather than a regression.
 */
describe('renderAgentPrompt(Agent.PLANNING) — byte-parity with the monolithic brain prompt', () => {
  const PRE_SPLIT_SHA256: Record<string, string> = {
    feature: 'c754924a1d8253a599fb792696153b98f61d0d479388596833f25f9a7974c879',
    bugfix: 'c1532a05911e45326e10192cee0cf48c34005be785e8297599dc8524218612de',
    onboarding: '9b18e9e0ca07866b78e9e1fbe693e44a90fa290e3381f43f8a61ebed25522bf8',
    review: 'c0d59541f22b0becf75d6b09960307a8c24c2635950421db9a2498cd752da405',
  };

  it.each(['feature', 'bugfix', 'onboarding', 'review'] as const)(
    'jobKind=%s renders byte-identical to the monolithic brain snapshot',
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
    expect(prompts.generate(Agent.PLANNING, { jobKind: 'feature' }).length).toBeGreaterThan(10_000);
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
    expect(Object.keys(getFragmentMetaMap(Object.getPrototypeOf(instance)))).toEqual(['a', 'b']);
    expect(() => validateFragments(loadFragmentsFromInstances([instance]))).toThrow(
      /duplicate order 5000 for agent/,
    );
  });
});
