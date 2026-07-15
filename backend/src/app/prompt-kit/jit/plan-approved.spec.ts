/**
 * prompt-kit / jit — specs for the `plan-approved` JIT rule (Thread 6: approval-gated dispatch).
 */
import { describe, it, expect } from 'vitest';
import { findLifecycleRule } from './rules';
import { planApprovedRule, renderPlanApprovedSeed } from './plan-approved';

describe('renderPlanApprovedSeed', () => {
  it('full plan: instructs rebase + auto-resolve conflicts, dispatch_build, hold_build, and names the base', () => {
    const body = renderPlanApprovedSeed({
      buildPath: 'plan',
      baseBranch: 'main',
    });
    expect(body).toContain('git fetch origin');
    expect(body).toContain('main');
    expect(body).toContain('ALWAYS resolve any git-level merge conflict');
    expect(body).toContain('dispatch_build');
    expect(body).toContain('hold_build');
  });

  it('direct build: same instruction — still says dispatch_build (the tool branches internally)', () => {
    const body = renderPlanApprovedSeed({
      buildPath: 'direct',
      baseBranch: 'main',
    });
    expect(body).toContain('dispatch_build');
    expect(body).toContain('hold_build');
    expect(body).toContain('git fetch origin');
  });

  it('falls back to "the base branch" when no base branch is given', () => {
    const body = renderPlanApprovedSeed({});
    expect(body).toContain('the base branch');
  });
});

describe('planApprovedRule', () => {
  it('is a lifecycle plan-approved rule delivered as a host seed notice', () => {
    expect(planApprovedRule.trigger).toEqual({
      kind: 'lifecycle',
      event: 'plan-approved',
    });
    expect(planApprovedRule.delivery).toBe('host-seed-notice');
    expect(planApprovedRule.seed).toBeDefined();
  });

  it('render matches renderPlanApprovedSeed', () => {
    const ctx = { buildPath: 'plan' as const, baseBranch: 'develop' };
    expect(planApprovedRule.render(ctx)).toBe(renderPlanApprovedSeed(ctx));
  });

  it('seed chunkKey is keyed by decisionRecordId, falling back to jobId', () => {
    expect(planApprovedRule.seed?.chunkKey({ decisionRecordId: 'dr-1' })).toBe(
      'seed:plan-approved:dr-1',
    );
    expect(planApprovedRule.seed?.chunkKey({ jobId: 'J' })).toBe(
      'seed:plan-approved:J',
    );
  });

  it('findLifecycleRule resolves plan-approved to planApprovedRule', () => {
    expect(findLifecycleRule('plan-approved')).toBe(planApprovedRule);
  });
});
