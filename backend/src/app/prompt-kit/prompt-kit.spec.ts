import { describe, expect, it } from 'vitest';
import {
  BASELINE_FIRST_NOTE,
  CLOUD_SANDBOX_NOTE,
  DELETION_SAFETY_NOTE,
  DEVIATION_NOTE,
  REPORT_ONLY_NOTE,
  SPIKE_FIRST_NOTE,
  VALIDATE_BY_RUNNING_NOTE,
  VERIFY_NOTE,
  buildSystemPrompt,
  jobKindFragment,
  listPromptIds,
  renderSystemPrompt,
} from './index';
import { ORCHESTRATE_EXECUTE_SYSTEM } from './bodies/worker.body';

describe('jobKindFragment', () => {
  it('is empty for null/undefined (composing without a kind is a no-op)', () => {
    expect(jobKindFragment(null)).toBe('');
    expect(jobKindFragment(undefined)).toBe('');
  });

  it('gives a distinct context block per kind', () => {
    expect(jobKindFragment('feature')).toContain('JOB KIND — FEATURE');
    expect(jobKindFragment('bugfix')).toContain('JOB KIND — BUGFIX');
    expect(jobKindFragment('event')).toContain('JOB KIND — EVENT');
  });

  it('is empty for onboarding (the onboarding body already owns that framing)', () => {
    expect(jobKindFragment('onboarding')).toBe('');
  });
});

describe('buildSystemPrompt composition', () => {
  it('leads with the body, then job-kind block, then the audience layer', () => {
    const out = buildSystemPrompt({
      audience: 'worker',
      jobKind: 'feature',
      body: ORCHESTRATE_EXECUTE_SYSTEM,
    });
    const bodyAt = out.indexOf('You are Atlas, the ORCHESTRATOR');
    const kindAt = out.indexOf('JOB KIND — FEATURE');
    const validateAt = out.indexOf('VALIDATE BY RUNNING');
    expect(bodyAt).toBeGreaterThanOrEqual(0);
    expect(kindAt).toBeGreaterThan(bodyAt);
    expect(validateAt).toBeGreaterThan(kindAt);
  });

  it('injects the worker layer (validate-by-running + spike-first)', () => {
    const out = buildSystemPrompt({ audience: 'worker', body: 'BODY' });
    expect(out).toContain(VALIDATE_BY_RUNNING_NOTE);
    expect(out).toContain(SPIKE_FIRST_NOTE);
  });

  it('injects the brain/planner layer (baseline-first + spike-first)', () => {
    for (const audience of ['brain', 'planner'] as const) {
      const out = buildSystemPrompt({ audience, body: 'BODY' });
      expect(out).toContain(BASELINE_FIRST_NOTE);
      expect(out).toContain(SPIKE_FIRST_NOTE);
    }
  });

  it('supplies the sandbox note EXACTLY once for driver audiences (composer owns it, body does not)', () => {
    // The relocated worker body no longer embeds CLOUD_SANDBOX_NOTE — the composer's per-audience framing adds it.
    expect(ORCHESTRATE_EXECUTE_SYSTEM).not.toContain(CLOUD_SANDBOX_NOTE);
    const out = buildSystemPrompt({
      audience: 'worker',
      jobKind: 'feature',
      body: ORCHESTRATE_EXECUTE_SYSTEM,
    });
    const occurrences = out.split(CLOUD_SANDBOX_NOTE).length - 1;
    expect(occurrences).toBe(1);
  });

  it('gives the sandbox framing to driver audiences but NOT the brain (bespoke framing) or meta', () => {
    for (const audience of ['worker', 'planner', 'ship'] as const) {
      expect(buildSystemPrompt({ audience, body: 'BODY' })).toContain(CLOUD_SANDBOX_NOTE);
    }
    for (const audience of ['brain', 'meta', 'review'] as const) {
      expect(buildSystemPrompt({ audience, body: 'BODY' })).not.toContain(CLOUD_SANDBOX_NOTE);
    }
  });

  it('omits the job-kind block when kind is null', () => {
    const out = buildSystemPrompt({ audience: 'brain', jobKind: null, body: 'BODY' });
    expect(out).not.toContain('JOB KIND —');
  });
});

describe('catalog blocks (the full-sweep de-duplication)', () => {
  // Each shared policy block must appear in EVERY listed consumer's rendered prompt, exactly once
  // (occurrence count === 1 catches a double-splice). This is the anti-drift guarantee.
  const BLOCK_CONSUMERS: Array<{ name: string; block: string; ids: string[] }> = [
    { name: 'VERIFY_NOTE', block: VERIFY_NOTE, ids: ['worker-step', 'worker-batch'] },
    {
      name: 'DEVIATION_NOTE',
      block: DEVIATION_NOTE,
      ids: ['worker-step', 'worker-batch', 'worker-orchestrate', 'subagent-writer'],
    },
    {
      name: 'DELETION_SAFETY_NOTE',
      block: DELETION_SAFETY_NOTE,
      ids: ['worker-step', 'worker-batch', 'worker-orchestrate'],
    },
    {
      name: 'REPORT_ONLY_NOTE',
      block: REPORT_ONLY_NOTE,
      ids: ['subagent-explore', 'subagent-docs', 'subagent-review', 'subagent-test'],
    },
  ];

  it('each shared block appears exactly once in every listed consumer', () => {
    for (const { name, block, ids } of BLOCK_CONSUMERS) {
      for (const id of ids) {
        const out = renderSystemPrompt(id, {}) as string;
        expect(out, `${name} missing in ${id}`).toContain(block);
        expect(out.split(block).length - 1, `${name} not exactly-once in ${id}`).toBe(1);
      }
    }
  });

  it('brain + onboarding share the tool-qualification block', () => {
    for (const id of ['brain', 'brain-onboarding']) {
      expect(renderSystemPrompt(id, {}) as string, id).toContain('MUST be called by its FULLY-QUALIFIED name');
    }
  });

  it('preserves the test-runs-Bash / debug-no-commands distinction (not erased by REPORT_ONLY_NOTE)', () => {
    const debug = renderSystemPrompt('subagent-debug', {}) as string;
    const test = renderSystemPrompt('subagent-test', {}) as string;
    expect(debug).toContain('Do NOT run commands');
    expect(test).toContain('using Bash');
    // debug keeps its own read-only line — it must NOT carry the shared report-only block.
    expect(debug).not.toContain(REPORT_ONLY_NOTE);
  });
});

describe('shared review scope', () => {
  it('the master review and the review subagent hunt the SAME dimensions', () => {
    const master = renderSystemPrompt('ship-master-review', {}) as string;
    const subagent = renderSystemPrompt('subagent-review', {}) as string;
    // The ship gate must not be narrower than the per-step reviewer: both carry error-handling/edge-cases.
    for (const text of [master, subagent]) {
      expect(text).toContain('missing edge cases or error handling');
      expect(text).toContain('conventions this repo already follows');
    }
  });
});

describe('prompt registry (preview endpoint source of truth)', () => {
  const ids = listPromptIds();

  it('exposes the key production prompts', () => {
    const set = new Set(ids.map((e) => e.id));
    for (const id of [
      'brain',
      'brain-onboarding',
      'worker-orchestrate',
      'worker-step',
      'worker-batch',
      'planner-thread-plan',
      'ship-pr-review',
      'autofix-review',
      'subagent-writer',
      'meta-decision-classifier',
    ]) {
      expect(set.has(id)).toBe(true);
    }
  });

  it('renders every id non-empty, for null and for each job kind', () => {
    for (const { id } of ids) {
      for (const kind of [null, 'feature', 'bugfix', 'onboarding', 'event'] as const) {
        const text = renderSystemPrompt(id, { jobKind: kind });
        expect(text, `${id} @ ${kind}`).toBeTruthy();
        expect((text as string).length, `${id} @ ${kind}`).toBeGreaterThan(0);
      }
    }
  });

  it('composed worker prompt carries the behavioral fragments + job-kind block', () => {
    const text = renderSystemPrompt('worker-orchestrate', { jobKind: 'feature' }) as string;
    expect(text).toContain('VALIDATE BY RUNNING');
    expect(text).toContain('SPIKE BEFORE YOU COMMIT');
    expect(text).toContain('JOB KIND — FEATURE');
  });

  it('EVERY raw prompt ignores the job kind (sent verbatim in production)', () => {
    for (const { id, audience } of ids) {
      if (audience !== 'raw') continue;
      const withKind = renderSystemPrompt(id, { jobKind: 'feature' });
      const without = renderSystemPrompt(id, { jobKind: null });
      expect(withKind, id).toBe(without);
      expect(withKind as string, id).not.toContain('JOB KIND —');
    }
  });

  it('pins the composed set (the ids that get layers + a job-kind block; the rest are raw)', () => {
    // Production and the preview endpoint BOTH go through `renderSystemPrompt(id)`, so there is only one
    // code path — this just documents which prompts are composed, so an accidental audience flip is caught.
    const composed = ids.filter((e) => e.audience !== 'raw').map((e) => e.id).sort();
    expect(composed).toEqual(
      [
        'brain',
        'brain-onboarding',
        'planner-thread-plan',
        'ship-pr-review',
        'worker-batch',
        'worker-orchestrate',
        'worker-step',
      ].sort(),
    );
  });

  it('throws (fail-fast) on an unknown id', () => {
    expect(() => renderSystemPrompt('nope', {})).toThrow(/Unknown system prompt id/);
  });
});
