import {
  AUTHOR_LIVE_VALIDATION_NOTE,
  BASELINE_FIRST_NOTE,
  CANDOR_NOTE,
  CLARITY_OVER_COMMENTS_NOTE,
  CLOUD_SANDBOX_NOTE,
  DELETION_SAFETY_NOTE,
  DESIGN_DISCIPLINE_NOTE,
  DEVIATION_NOTE,
  DOC_VERSION_VERIFY_NOTE,
  EVIDENCE_ARTIFACTS_NOTE,
  MINIMAL_CODE_NOTE,
  REPORT_ONLY_NOTE,
  RUNNABLE_WORKSPACE_NOTE,
  SANDBOX_FILESYSTEM_MAP_NOTE,
  SOLE_AUTHOR_NOTE,
  SPIKE_FIRST_NOTE,
  SUBAGENT_KERNEL_NOTE,
  SUBAGENT_NUDGE_NOTE,
  TS_STYLE_NOTE,
  VALIDATE_BY_RUNNING_NOTE,
} from '@shared/prompt-kit/system/fragments';
import {
  AGENT_PROMPTS,
  hasAgentPrompt,
  listAgentPrompts,
  renderPreview,
} from '@shared/prompt-kit/system/preview';
import { describe, expect, it } from 'vitest';
import { Agent, jobKindFragment, renderAgentPrompt } from './index';

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
    for (const agent of [Agent.PLANNING, Agent.WORKER, Agent.FAN_OUT]) {
      const out = renderAgentPrompt(agent, { jobKind: 'feature' });
      expect(out.split(CLARITY_OVER_COMMENTS_NOTE).length - 1, String(agent)).toBe(1);
    }
    expect(renderAgentPrompt(Agent.PLANNING, { jobKind: 'onboarding' })).toContain(
      CLARITY_OVER_COMMENTS_NOTE,
    );
    for (const agent of [Agent.REVIEW_AGENT, Agent.MASTER_REVIEW, Agent.AUTOFIX_FIX]) {
      expect(renderAgentPrompt(agent), String(agent)).not.toContain(CLARITY_OVER_COMMENTS_NOTE);
    }
  });

  it('TS_STYLE_NOTE reaches every code-writing agent (authors + fix lanes) but no read-only advisory persona', () => {
    for (const agent of [
      Agent.PLANNING,
      Agent.WORKER,
      Agent.FAN_OUT,
      Agent.MASTER_REVIEW,
      Agent.AUTOFIX_FIX,
    ]) {
      const out = renderAgentPrompt(agent, { jobKind: 'feature' });
      expect(out.split(TS_STYLE_NOTE).length - 1, String(agent)).toBe(1);
    }
    expect(renderAgentPrompt(Agent.PLANNING, { jobKind: 'onboarding' })).toContain(TS_STYLE_NOTE);
    for (const agent of [Agent.EXPLORE, Agent.DOCS, Agent.REVIEW_AGENT, Agent.DEBUG, Agent.TEST]) {
      expect(renderAgentPrompt(agent), String(agent)).not.toContain(TS_STYLE_NOTE);
    }
  });

  it('DESIGN_DISCIPLINE_NOTE reaches the code-authoring personas (brain + worker + fan-out writers) and points at the skill', () => {
    for (const agent of [Agent.PLANNING, Agent.WORKER, Agent.FAN_OUT]) {
      const out = renderAgentPrompt(agent, { jobKind: 'feature' });
      expect(out.split(DESIGN_DISCIPLINE_NOTE).length - 1, String(agent)).toBe(1);
      expect(out, String(agent)).toContain('DESIGN DISCIPLINE');
      expect(out, String(agent)).toContain('`design-patterns` skill');
    }
    expect(renderAgentPrompt(Agent.PLANNING, { jobKind: 'onboarding' })).toContain(
      DESIGN_DISCIPLINE_NOTE,
    );
    for (const agent of [Agent.EXPLORE, Agent.DOCS, Agent.REVIEW_AGENT, Agent.DEBUG, Agent.TEST]) {
      expect(renderAgentPrompt(agent), String(agent)).not.toContain(DESIGN_DISCIPLINE_NOTE);
    }
    expect(renderAgentPrompt(Agent.PLANNING, { jobKind: 'review' })).not.toContain(
      DESIGN_DISCIPLINE_NOTE,
    );
  });

  it('DOC_VERSION_VERIFY_NOTE reaches the three code authors but not the fix lanes or advisories', () => {
    for (const agent of [Agent.PLANNING, Agent.WORKER, Agent.FAN_OUT]) {
      const out = renderAgentPrompt(agent, { jobKind: 'feature' });
      expect(out.split(DOC_VERSION_VERIFY_NOTE).length - 1, String(agent)).toBe(1);
    }
    expect(renderAgentPrompt(Agent.PLANNING, { jobKind: 'onboarding' })).toContain(
      DOC_VERSION_VERIFY_NOTE,
    );
    for (const agent of [Agent.MASTER_REVIEW, Agent.AUTOFIX_FIX, Agent.EXPLORE, Agent.DOCS]) {
      expect(renderAgentPrompt(agent), String(agent)).not.toContain(DOC_VERSION_VERIFY_NOTE);
    }
  });

  it('the plan reviewer mandates verifying current docs + the installed version before certifying a choice', () => {
    const out = renderAgentPrompt(Agent.META_PLAN_REVIEW);
    expect(out).toContain('MUST use it whenever the plan rests on a version-sensitive detail');
    expect(out).toContain('WEB-SEARCH');
  });

  it('the brain UI-preview instruction routes the mockup to the `prototype` subagent, not `implement`', () => {
    const brain = renderAgentPrompt(Agent.PLANNING, { jobKind: 'feature' });
    expect(brain).toContain('DELEGATE the prototype build to the dedicated `prototype` subagent');
    expect(brain).not.toContain('DELEGATE the prototype build to the `implement` writer subagent');
  });

  it('CANDOR_NOTE reaches the brain (feature + onboarding) but no worker/subagent persona', () => {
    expect(renderAgentPrompt(Agent.PLANNING, { jobKind: 'feature' })).toContain(CANDOR_NOTE);
    expect(renderAgentPrompt(Agent.PLANNING, { jobKind: 'onboarding' })).toContain(CANDOR_NOTE);
    for (const agent of [Agent.WORKER, Agent.FAN_OUT, Agent.REVIEW_AGENT, Agent.MASTER_REVIEW]) {
      expect(renderAgentPrompt(agent, { jobKind: 'feature' }), String(agent)).not.toContain(
        CANDOR_NOTE,
      );
    }
  });

  it('REPORT_ONLY_NOTE reaches the advisory subagents but NOT debug (it keeps its own line)', () => {
    for (const agent of [Agent.EXPLORE, Agent.DOCS, Agent.REVIEW_AGENT, Agent.TEST]) {
      expect(renderAgentPrompt(agent), String(agent)).toContain(REPORT_ONLY_NOTE);
    }
    const debug = renderAgentPrompt(Agent.DEBUG);
    expect(debug).toContain('Do NOT run commands');
    expect(debug).not.toContain(REPORT_ONLY_NOTE);
    expect(renderAgentPrompt(Agent.TEST)).toContain('using Bash'); // test/debug command distinction preserved
  });

  it('the sole-author invariant reaches every file-touching / operator-facing agent, exactly once', () => {
    for (const agent of [Agent.WORKER, Agent.FAN_OUT, Agent.MASTER_REVIEW]) {
      const out = renderAgentPrompt(agent, { jobKind: 'feature' });
      expect(out.split(SOLE_AUTHOR_NOTE).length - 1, String(agent)).toBe(1);
    }
    expect(renderAgentPrompt(Agent.PLANNING, { jobKind: 'feature' })).toContain(SOLE_AUTHOR_NOTE);
    expect(renderAgentPrompt(Agent.PLANNING, { jobKind: 'onboarding' })).toContain(
      SOLE_AUTHOR_NOTE,
    );
  });

  it('the sandbox filesystem map reaches the brain (build) but not the builder', () => {
    expect(renderAgentPrompt(Agent.PLANNING, { jobKind: 'feature' })).toContain(
      SANDBOX_FILESYSTEM_MAP_NOTE,
    );
    for (const agent of [Agent.WORKER, Agent.FAN_OUT]) {
      expect(renderAgentPrompt(agent, { jobKind: 'feature' }), String(agent)).not.toContain(
        SANDBOX_FILESYSTEM_MAP_NOTE,
      );
    }
  });

  it('the cloud-sandbox note is ONE shared fragment on the composed driver persona (dedup)', () => {
    for (const agent of [Agent.WORKER]) {
      const out = renderAgentPrompt(agent, { jobKind: 'feature' });
      expect(out.split(CLOUD_SANDBOX_NOTE).length - 1, String(agent)).toBe(1);
    }
  });

  it('SUBAGENT_KERNEL_NOTE reaches every engine subagent (once) as a preamble, but not full-session agents', () => {
    for (const agent of [
      Agent.EXPLORE,
      Agent.DOCS,
      Agent.REVIEW_AGENT,
      Agent.DEBUG,
      Agent.TEST,
      Agent.VALIDATE,
      Agent.FAN_OUT,
    ]) {
      const out = renderAgentPrompt(agent);
      expect(out.split(SUBAGENT_KERNEL_NOTE).length - 1, String(agent)).toBe(1);
      expect(out.startsWith(SUBAGENT_KERNEL_NOTE), String(agent)).toBe(true);
    }
    for (const agent of [Agent.PLANNING, Agent.WORKER, Agent.MASTER_REVIEW]) {
      expect(renderAgentPrompt(agent, { jobKind: 'feature' }), String(agent)).not.toContain(
        SUBAGENT_KERNEL_NOTE,
      );
    }
  });

  it('SUBAGENT_NUDGE_NOTE reaches the two fan-out orchestrators (brain + worker), never the subagents', () => {
    for (const agent of [Agent.WORKER]) {
      const out = renderAgentPrompt(agent, { jobKind: 'feature' });
      expect(out.split(SUBAGENT_NUDGE_NOTE).length - 1, String(agent)).toBe(1);
    }
    expect(renderAgentPrompt(Agent.PLANNING, { jobKind: 'feature' })).toContain(
      SUBAGENT_NUDGE_NOTE,
    );
    for (const agent of [
      Agent.EXPLORE,
      Agent.DOCS,
      Agent.REVIEW_AGENT,
      Agent.DEBUG,
      Agent.TEST,
      Agent.FAN_OUT,
    ]) {
      expect(renderAgentPrompt(agent), String(agent)).not.toContain(SUBAGENT_NUDGE_NOTE);
    }
  });

  it('EVIDENCE_ARTIFACTS_NOTE reaches the worker orchestrator AND the validate subagent, not the writer/brain', () => {
    for (const agent of [Agent.WORKER, Agent.VALIDATE]) {
      const out = renderAgentPrompt(agent, { jobKind: 'feature' });
      expect(out.split(EVIDENCE_ARTIFACTS_NOTE).length - 1, String(agent)).toBe(1);
      expect(out, String(agent)).toContain('/context/artifacts');
      expect(out, String(agent)).toContain('RESULTS.md');
      expect(out, String(agent)).toContain('$ATLAS_EVIDENCE_DIR');
      expect(out, String(agent)).toContain('/context/evidence');
    }
    for (const agent of [Agent.FAN_OUT, Agent.PLANNING]) {
      expect(renderAgentPrompt(agent, { jobKind: 'feature' }), String(agent)).not.toContain(
        EVIDENCE_ARTIFACTS_NOTE,
      );
    }
  });

  it('the evidence owners must INSPECT captured artifacts, not just capture them (PR #106 regression)', () => {
    for (const agent of [Agent.WORKER, Agent.VALIDATE]) {
      const out = renderAgentPrompt(agent, { jobKind: 'feature' });
      expect(out, String(agent)).toContain('INSPECT WHAT YOU CAPTURED');
      expect(out, String(agent)).toContain('capturing an artifact is NOT the same as validating');
    }
    const brain = renderAgentPrompt(Agent.PLANNING, { jobKind: 'feature' });
    expect(brain).toContain('never finalize on an artifact you did not inspect');
  });

  it('the validate subagent renders a non-empty persona with its report contract', () => {
    const out = renderAgentPrompt(Agent.VALIDATE);
    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain('LIVE VALIDATION');
    expect(out).toContain('EXACT evidence paths'); // the report-back contract
    expect(out).toContain('$ATLAS_EVIDENCE_DIR');
  });

  it('RUNNABLE_WORKSPACE_NOTE reaches the build-touching lanes (brain, worker, master review) once, not the advisories', () => {
    for (const agent of [Agent.WORKER, Agent.MASTER_REVIEW]) {
      const out = renderAgentPrompt(agent, { jobKind: 'feature' });
      expect(out.split(RUNNABLE_WORKSPACE_NOTE).length - 1, String(agent)).toBe(1);
    }
    expect(renderAgentPrompt(Agent.PLANNING, { jobKind: 'feature' })).toContain(
      RUNNABLE_WORKSPACE_NOTE,
    );
    expect(renderAgentPrompt(Agent.PLANNING, { jobKind: 'onboarding' })).toContain(
      RUNNABLE_WORKSPACE_NOTE,
    );
    for (const agent of [
      Agent.EXPLORE,
      Agent.DOCS,
      Agent.REVIEW_AGENT,
      Agent.DEBUG,
      Agent.TEST,
      Agent.FAN_OUT,
    ]) {
      expect(renderAgentPrompt(agent), String(agent)).not.toContain(RUNNABLE_WORKSPACE_NOTE);
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

describe('public preview exposure prompt (opt-in --expose sequence)', () => {
  it('the PUBLIC PREVIEW URLS block composes into the build brain under notOnboarding', () => {
    for (const jobKind of ['feature', 'bugfix', 'event'] as const) {
      const out = renderAgentPrompt(Agent.PLANNING, { jobKind });
      expect(out, jobKind).toContain('PUBLIC PREVIEW URLS');
      expect(out, jobKind).toContain('--port <n>');
      expect(out, jobKind).toContain('$ATLAS_PREVIEW_ID');
      expect(out, jobKind).toContain('$ATLAS_PREVIEW_DOMAIN');
      expect(out, jobKind).toContain('BIND TO 0.0.0.0');
      expect(out, jobKind).toContain('--expose');
    }
  });

  it('onboarding reuses the exposure ordering inside LIVE-SERVICE ACCESSIBILITY', () => {
    const out = renderAgentPrompt(Agent.PLANNING, { jobKind: 'onboarding' });
    expect(out).toContain('LIVE-SERVICE ACCESSIBILITY');
    expect(out).toContain('BIND TO 0.0.0.0');
    expect(out).toContain('$ATLAS_PREVIEW_ID');
  });

  it('sandboxRuntime documents the --port flag alongside the run form', () => {
    const out = renderAgentPrompt(Agent.PLANNING, { jobKind: 'feature' });
    expect(out).toContain('atlas-svc run --name <id> [--port <n>] [--expose] -- <cmd>');
    expect(out).toContain('PORTS panel');
  });
});

describe('turn-aware WORKER prose — batch-only host-tool instructions gated by turnPhase', () => {
  const BATCH_ONLY_MARKERS = [
    '`complete_thread`',
    '`record_deviation`',
    'Before you call `complete_thread`',
  ];

  it('commit turns carry NO instruction for batch-only host tools', () => {
    for (const turnPhase of ['commit'] as const) {
      const out = renderAgentPrompt(Agent.WORKER, { turnPhase });
      for (const marker of BATCH_ONLY_MARKERS) {
        expect(out, `${turnPhase} / ${marker}`).not.toContain(marker);
      }
      expect(out, `${turnPhase} / DEVIATION_NOTE`).not.toContain(DEVIATION_NOTE);
      expect(out, `${turnPhase} / EVIDENCE_ARTIFACTS_NOTE`).not.toContain(EVIDENCE_ARTIFACTS_NOTE);
    }
  });

  it('batch turn (and the bare no-ctx default) DO carry the batch-only host-tool prose', () => {
    for (const out of [
      renderAgentPrompt(Agent.WORKER, { turnPhase: 'batch' }),
      renderAgentPrompt(Agent.WORKER),
    ]) {
      expect(out).toContain('`complete_thread`');
      expect(out).toContain(DEVIATION_NOTE);
      expect(out).toContain(EVIDENCE_ARTIFACTS_NOTE);
    }
  });
});

describe('shared review scope', () => {
  it('the master review and the review subagent hunt the SAME dimensions', () => {
    for (const agent of [Agent.MASTER_REVIEW, Agent.REVIEW_AGENT]) {
      const out = renderAgentPrompt(agent);
      expect(out, String(agent)).toContain('missing edge cases or error handling');
      expect(out, String(agent)).toContain('conventions this repo already follows');
    }
  });
});

describe('brain vs worker behavioral tails do not leak into each other', () => {
  it('the brain carries baseline+author-live-validation+spike; the worker carries validate+spike', () => {
    const brain = renderAgentPrompt(Agent.PLANNING, { jobKind: 'feature' });
    expect(brain).toContain(BASELINE_FIRST_NOTE);
    expect(brain).toContain(SPIKE_FIRST_NOTE);
    expect(brain).toContain(AUTHOR_LIVE_VALIDATION_NOTE);
    expect(brain).not.toContain(VALIDATE_BY_RUNNING_NOTE); // validate-by-running is a WORKER note, not brain
  });

  it('the external-PR review brain does not carry build-authoring guidance', () => {
    const review = renderAgentPrompt(Agent.PLANNING, { jobKind: 'review' });
    for (const note of [
      BASELINE_FIRST_NOTE,
      AUTHOR_LIVE_VALIDATION_NOTE,
      SPIKE_FIRST_NOTE,
      CLARITY_OVER_COMMENTS_NOTE,
      MINIMAL_CODE_NOTE,
      DESIGN_DISCIPLINE_NOTE,
      TS_STYLE_NOTE,
      DOC_VERSION_VERIFY_NOTE,
    ]) {
      expect(review).not.toContain(note);
    }
    expect(review).not.toContain('ACT WITH CARE, REPORT TRUTHFULLY');
    expect(review).toContain('You are Atlas, reviewing an EXISTING pull request');
  });
});

describe('POST_BUILD / CI lean prompts (the exploded-brain stages)', () => {
  const PLANNING_ONLY_MARKERS = [
    'GRILLING PROTOCOL',
    'WHY YOU GRILL',
    'propose_plan',
    'review_plan',
    'FULL PATH — review_plan then propose_plan',
  ];

  it('POST_BUILD carries the engineering base and its own gate identity', () => {
    const out = renderAgentPrompt(Agent.POST_BUILD, { jobKind: 'feature' });
    expect(out).toContain('YOU OWN GIT IN THE SANDBOX');
    expect(out).toContain(AUTHOR_LIVE_VALIDATION_NOTE);
    expect(out).toContain('You are Atlas at the SHIP-REVIEW GATE');
    for (const marker of PLANNING_ONLY_MARKERS) {
      expect(out, marker).not.toContain(marker);
    }
    expect(out).toContain('report_verification');
    expect(out).toContain('withdraw_ship');
    expect(out).not.toContain('__ask_question');
    expect(out).not.toContain('propose_convention_profile_change');
  });

  it('CI carries the engineering base and its own post-ship identity', () => {
    const out = renderAgentPrompt(Agent.CI, { jobKind: 'feature' });
    expect(out).toContain('YOU OWN GIT IN THE SANDBOX');
    expect(out).toContain(AUTHOR_LIVE_VALIDATION_NOTE);
    expect(out).toContain('You are Atlas owning the POST-SHIP PR lifecycle');
    for (const marker of PLANNING_ONLY_MARKERS) {
      expect(out, marker).not.toContain(marker);
    }
    expect(out).toContain('report_verification');
    expect(out).not.toContain('withdraw_ship');
    expect(out).not.toContain('__ask_question');
    expect(out).not.toContain('propose_convention_profile_change');
  });

  it('both lean prompts are substantially SHORTER than the full PLANNING prompt', () => {
    const planning = renderAgentPrompt(Agent.PLANNING, { jobKind: 'feature' });
    const postBuild = renderAgentPrompt(Agent.POST_BUILD, {
      jobKind: 'feature',
    });
    const ci = renderAgentPrompt(Agent.CI, { jobKind: 'feature' });
    expect(postBuild.length).toBeLessThan(planning.length);
    expect(ci.length).toBeLessThan(planning.length);
  });
});

describe('preview catalog (the dev-only /test/prompts source of truth)', () => {
  it('exposes every live agent prompt + renders each non-empty', () => {
    const ids = new Set(listAgentPrompts().map((e) => e.id));
    for (const id of [
      'brain',
      'brain-onboarding',
      'worker-orchestrate',
      'ship-master-review',
      'autofix-review',
      'subagent-writer',
    ]) {
      expect(ids.has(id), id).toBe(true);
    }
    for (const { id } of AGENT_PROMPTS) {
      expect(hasAgentPrompt(id), id).toBe(true);
      expect((renderPreview(id) ?? '').length, id).toBeGreaterThan(0);
    }
  });

  it('renderPreview honors a job-kind override for the composed personas', () => {
    expect(renderPreview('worker-orchestrate', 'bugfix')).toContain('JOB KIND — BUGFIX');
    expect(renderPreview('nope')).toBeNull();
  });
});
