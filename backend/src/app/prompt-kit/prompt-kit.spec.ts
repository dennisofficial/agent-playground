import { describe, expect, it } from 'vitest';
import {
  BASELINE_FIRST_NOTE,
  CANDOR_NOTE,
  CLARITY_OVER_COMMENTS_NOTE,
  CLOUD_SANDBOX_NOTE,
  DELETION_SAFETY_NOTE,
  DEVIATION_NOTE,
  REPORT_ONLY_NOTE,
  SOLE_AUTHOR_NOTE,
  SPIKE_FIRST_NOTE,
  VALIDATE_BY_RUNNING_NOTE,
} from './fragments';
import { Agent, jobKindFragment, renderAgentPrompt } from './index';
import {
  AGENT_PROMPTS,
  hasAgentPrompt,
  listAgentPrompts,
  renderPreview,
} from './preview';

describe('jobKindFragment', () => {
  it('is empty for null/undefined + onboarding; distinct per build kind', () => {
    expect(jobKindFragment(null)).toBe('');
    expect(jobKindFragment('onboarding')).toBe('');
    expect(jobKindFragment('feature')).toContain('JOB KIND — FEATURE');
    expect(jobKindFragment('bugfix')).toContain('JOB KIND — BUGFIX');
    expect(jobKindFragment('event')).toContain('JOB KIND — EVENT');
  });
});

describe('composer dedup — shared blocks reach the right agents, exactly once', () => {
  it('DEVIATION_NOTE reaches the worker orchestrator AND the writer', () => {
    for (const agent of [Agent.WORKER, Agent.FAN_OUT]) {
      const out = renderAgentPrompt(agent);
      expect(out, String(agent)).toContain(DEVIATION_NOTE);
    }
  });

  it('DELETION_SAFETY_NOTE reaches the worker orchestrator', () => {
    expect(renderAgentPrompt(Agent.WORKER)).toContain(DELETION_SAFETY_NOTE);
  });

  it('CLARITY_OVER_COMMENTS_NOTE reaches every code author but no reviewer or minimal-diff persona', () => {
    for (const agent of [Agent.ATLAS_MAIN, Agent.WORKER, Agent.FAN_OUT]) {
      const out = renderAgentPrompt(agent, { jobKind: 'feature' });
      expect(out.split(CLARITY_OVER_COMMENTS_NOTE).length - 1, String(agent)).toBe(1);
    }
    // onboarding brain authors code too (script fixes) — it rides the un-gated behavioral tail.
    expect(renderAgentPrompt(Agent.ATLAS_MAIN, { jobKind: 'onboarding' })).toContain(
      CLARITY_OVER_COMMENTS_NOTE,
    );
    // deliberately excluded: reviewers and the minimal-diff autofix apply persona.
    for (const agent of [Agent.REVIEW_AGENT, Agent.PR_REVIEW, Agent.MASTER_REVIEW, Agent.AUTOFIX_FIX]) {
      expect(renderAgentPrompt(agent), String(agent)).not.toContain(CLARITY_OVER_COMMENTS_NOTE);
    }
  });

  it('CANDOR_NOTE reaches the brain (feature + onboarding) but no worker/subagent persona', () => {
    expect(renderAgentPrompt(Agent.ATLAS_MAIN, { jobKind: 'feature' })).toContain(CANDOR_NOTE);
    expect(renderAgentPrompt(Agent.ATLAS_MAIN, { jobKind: 'onboarding' })).toContain(CANDOR_NOTE);
    // brain-only conversational stance: not the build/review/writer personas.
    for (const agent of [Agent.WORKER, Agent.FAN_OUT, Agent.REVIEW_AGENT, Agent.PR_REVIEW]) {
      expect(renderAgentPrompt(agent, { jobKind: 'feature' }), String(agent)).not.toContain(CANDOR_NOTE);
    }
  });

  it('REPORT_ONLY_NOTE reaches the advisory subagents but NOT debug (it keeps its own line)', () => {
    for (const agent of [
      Agent.EXPLORE,
      Agent.DOCS,
      Agent.REVIEW_AGENT,
      Agent.TEST,
    ]) {
      expect(renderAgentPrompt(agent), String(agent)).toContain(
        REPORT_ONLY_NOTE,
      );
    }
    const debug = renderAgentPrompt(Agent.DEBUG);
    expect(debug).toContain('Do NOT run commands');
    expect(debug).not.toContain(REPORT_ONLY_NOTE);
    expect(renderAgentPrompt(Agent.TEST)).toContain('using Bash'); // test/debug command distinction preserved
  });

  it('the sole-author invariant reaches every file-touching / operator-facing agent, exactly once', () => {
    // brain (feature + onboarding), worker orchestrator, pr-review, and the fan-out writer.
    for (const agent of [Agent.WORKER, Agent.PR_REVIEW, Agent.FAN_OUT]) {
      const out = renderAgentPrompt(agent, { jobKind: 'feature' });
      expect(out.split(SOLE_AUTHOR_NOTE).length - 1, String(agent)).toBe(1);
    }
    expect(renderAgentPrompt(Agent.ATLAS_MAIN, { jobKind: 'feature' })).toContain(SOLE_AUTHOR_NOTE);
    expect(renderAgentPrompt(Agent.ATLAS_MAIN, { jobKind: 'onboarding' })).toContain(SOLE_AUTHOR_NOTE);
  });

  it('the cloud-sandbox note is ONE shared fragment across the composed driver personas (dedup)', () => {
    // worker + pr-review get the note from the SAME DriverFramingGroup fragment, exactly once each.
    for (const agent of [Agent.WORKER, Agent.PR_REVIEW]) {
      const out = renderAgentPrompt(agent, { jobKind: 'feature' });
      expect(out.split(CLOUD_SANDBOX_NOTE).length - 1, String(agent)).toBe(1);
    }
  });

  it('the worker behavioral tail (validate + spike) follows the job-kind block, in order', () => {
    const out = renderAgentPrompt(Agent.WORKER, { jobKind: 'feature' });
    const jobKindAt = out.indexOf('JOB KIND — FEATURE');
    const validateAt = out.indexOf(VALIDATE_BY_RUNNING_NOTE);
    const spikeAt = out.indexOf(SPIKE_FIRST_NOTE);
    expect(jobKindAt).toBeGreaterThan(0);
    expect(validateAt).toBeGreaterThan(jobKindAt);
    expect(spikeAt).toBeGreaterThan(validateAt);
  });
});

describe('shared review scope', () => {
  it('the master review and the review subagent hunt the SAME dimensions', () => {
    for (const agent of [Agent.MASTER_REVIEW, Agent.REVIEW_AGENT]) {
      const out = renderAgentPrompt(agent);
      expect(out, String(agent)).toContain(
        'missing edge cases or error handling',
      );
      expect(out, String(agent)).toContain(
        'conventions this repo already follows',
      );
    }
  });
});

describe('brain vs worker behavioral tails do not leak into each other', () => {
  it('the brain carries baseline+spike; the worker carries validate+spike', () => {
    const brain = renderAgentPrompt(Agent.ATLAS_MAIN, { jobKind: 'feature' });
    expect(brain).toContain(BASELINE_FIRST_NOTE);
    expect(brain).toContain(SPIKE_FIRST_NOTE);
    expect(brain).not.toContain(VALIDATE_BY_RUNNING_NOTE); // validate-by-running is a WORKER note, not brain
  });
});

describe('preview catalog (the dev-only /test/prompts source of truth)', () => {
  it('exposes every live agent prompt + renders each non-empty', () => {
    const ids = new Set(listAgentPrompts().map((e) => e.id));
    for (const id of [
      'brain',
      'brain-onboarding',
      'worker-orchestrate',
      'ship-pr-review',
      'ship-master-review',
      'ship-open-pr',
      'autofix-review',
      'subagent-writer',
      'meta-decision-classifier',
    ]) {
      expect(ids.has(id), id).toBe(true);
    }
    for (const { id } of AGENT_PROMPTS) {
      expect(hasAgentPrompt(id), id).toBe(true);
      expect((renderPreview(id) ?? '').length, id).toBeGreaterThan(0);
    }
  });

  it('renderPreview honors a job-kind override for the composed personas', () => {
    expect(renderPreview('worker-orchestrate', 'bugfix')).toContain(
      'JOB KIND — BUGFIX',
    );
    expect(renderPreview('nope')).toBeNull();
  });
});
