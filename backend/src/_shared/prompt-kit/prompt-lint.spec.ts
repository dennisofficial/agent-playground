import { describe, expect, it } from 'vitest';
import { Agent } from './system/agent';
import { primeFragments, renderAgentPrompt } from './system/assemble';
import {
  AUTHOR_LIVE_VALIDATION_NOTE,
  BASELINE_FIRST_NOTE,
  CANDOR_NOTE,
  CLARITY_OVER_COMMENTS_NOTE,
  CLOUD_SANDBOX_NOTE,
  DELETION_SAFETY_NOTE,
  DESIGN_DISCIPLINE_NOTE,
  DEVIATION_NOTE,
  DOCS_BEFORE_GREP,
  DOC_VERSION_VERIFY_NOTE,
  EVIDENCE_ARTIFACTS_NOTE,
  LSP_NAV_NOTE,
  LSP_TOOLS_NOTE,
  MINIMAL_CODE_NOTE,
  PLAYGROUND_NOTE,
  REPORT_ONLY_NOTE,
  REVIEW_SCOPE_NOTE,
  SANDBOX_FILESYSTEM_MAP_NOTE,
  SOLE_AUTHOR_NOTE,
  SPIKE_FIRST_NOTE,
  SUBAGENT_KERNEL_NOTE,
  SUBAGENT_NUDGE_NOTE,
  TASK_LIST_NOTE,
  TS_STYLE_NOTE,
  VALIDATE_BY_RUNNING_NOTE,
} from './system/fragments';
import { AGENT_PROMPTS } from './system/preview';
import type { PromptCtx } from './system/prompt-ctx';

describe('prompt-lint / every fragment order is an integer', () => {
  it('no fractional or non-finite orders survive', () => {
    for (const f of primeFragments()) {
      expect(Number.isInteger(f.meta.order), `${f.id} has order ${f.meta.order}`).toBe(true);
    }
  });
});

describe('prompt-lint / no sentence-run double space in any assembled prompt', () => {
  const SENTENCE_DOUBLE_SPACE = /[.!?] {2,}\S/;
  for (const entry of AGENT_PROMPTS) {
    it(`"${entry.id}" (${entry.agent})`, () => {
      const out = renderAgentPrompt(entry.agent, entry.ctx);
      const hit = SENTENCE_DOUBLE_SPACE.exec(out);
      const near = hit ? out.slice(Math.max(0, hit.index - 30), hit.index + 30) : '';
      expect(hit, near && `double space near: ${JSON.stringify(near)}`).toBeNull();
    });
  }
});

describe('prompt-lint / every persona declares a role (+ review personas a report contract)', () => {
  const ROLE_MARKER = /\bYou are\b|<role>/;
  const PERSONAS: Array<{ agent: Agent; ctx: PromptCtx; contract?: string }> = [
    { agent: Agent.PLANNING, ctx: { jobKind: 'feature' } },
    { agent: Agent.PLANNING, ctx: { jobKind: 'onboarding' } },
    { agent: Agent.POST_BUILD, ctx: { jobKind: 'feature' } },
    { agent: Agent.CI, ctx: { jobKind: 'feature' } },
    { agent: Agent.WORKER, ctx: { jobKind: 'feature' } },
    { agent: Agent.FAN_OUT, ctx: {} },
    { agent: Agent.EXPLORE, ctx: {} },
    { agent: Agent.DOCS, ctx: {} },
    { agent: Agent.DEBUG, ctx: {} },
    { agent: Agent.TEST, ctx: {} },
    { agent: Agent.VALIDATE, ctx: {} },
    { agent: Agent.PROTOTYPE, ctx: {} },
    { agent: Agent.AUTOFIX_FIX, ctx: {} },
    { agent: Agent.MASTER_REVIEW, ctx: {}, contract: REVIEW_SCOPE_NOTE },
    { agent: Agent.REVIEW_AGENT, ctx: {}, contract: REVIEW_SCOPE_NOTE },
    { agent: Agent.AUTOFIX_REVIEW, ctx: {}, contract: 'JSON contract' },
    { agent: Agent.META_PLAN_REVIEW, ctx: {}, contract: '<output_contract>' },
  ];

  it('covers every Agent enum value', () => {
    const covered = new Set(PERSONAS.map((p) => p.agent));
    for (const agent of Object.values(Agent)) {
      expect(covered.has(agent), String(agent)).toBe(true);
    }
  });

  for (const { agent, ctx, contract } of PERSONAS) {
    it(`${agent} (${ctx.jobKind ?? 'default'})`, () => {
      const out = renderAgentPrompt(agent, ctx);
      expect(out.length, String(agent)).toBeGreaterThan(0);
      expect(ROLE_MARKER.test(out), `${agent} has no role statement`).toBe(true);
      if (contract) {
        expect(out, `${agent} is missing its report contract`).toContain(contract);
      }
    });
  }
});

describe('prompt-lint / no shared fragment is included twice for one agent', () => {
  const SHARED_NOTES: Array<[string, string]> = [
    ['CLOUD_SANDBOX_NOTE', CLOUD_SANDBOX_NOTE],
    ['SOLE_AUTHOR_NOTE', SOLE_AUTHOR_NOTE],
    ['SANDBOX_FILESYSTEM_MAP_NOTE', SANDBOX_FILESYSTEM_MAP_NOTE],
    ['TASK_LIST_NOTE', TASK_LIST_NOTE],
    ['DOCS_BEFORE_GREP', DOCS_BEFORE_GREP],
    ['DOC_VERSION_VERIFY_NOTE', DOC_VERSION_VERIFY_NOTE],
    ['LSP_TOOLS_NOTE', LSP_TOOLS_NOTE],
    ['LSP_NAV_NOTE', LSP_NAV_NOTE],
    ['BASELINE_FIRST_NOTE', BASELINE_FIRST_NOTE],
    ['AUTHOR_LIVE_VALIDATION_NOTE', AUTHOR_LIVE_VALIDATION_NOTE],
    ['DEVIATION_NOTE', DEVIATION_NOTE],
    ['CLARITY_OVER_COMMENTS_NOTE', CLARITY_OVER_COMMENTS_NOTE],
    ['TS_STYLE_NOTE', TS_STYLE_NOTE],
    ['DELETION_SAFETY_NOTE', DELETION_SAFETY_NOTE],
    ['MINIMAL_CODE_NOTE', MINIMAL_CODE_NOTE],
    ['DESIGN_DISCIPLINE_NOTE', DESIGN_DISCIPLINE_NOTE],
    ['SUBAGENT_KERNEL_NOTE', SUBAGENT_KERNEL_NOTE],
    ['SUBAGENT_NUDGE_NOTE', SUBAGENT_NUDGE_NOTE],
    ['REPORT_ONLY_NOTE', REPORT_ONLY_NOTE],
    ['PLAYGROUND_NOTE', PLAYGROUND_NOTE],
    ['VALIDATE_BY_RUNNING_NOTE', VALIDATE_BY_RUNNING_NOTE],
    ['EVIDENCE_ARTIFACTS_NOTE', EVIDENCE_ARTIFACTS_NOTE],
    ['SPIKE_FIRST_NOTE', SPIKE_FIRST_NOTE],
    ['CANDOR_NOTE', CANDOR_NOTE],
  ];

  for (const entry of AGENT_PROMPTS) {
    it(`"${entry.id}" (${entry.agent})`, () => {
      const out = renderAgentPrompt(entry.agent, entry.ctx);
      for (const [name, note] of SHARED_NOTES) {
        const occurrences = out.split(note).length - 1;
        expect(occurrences, `${name} appears ${occurrences}× in ${entry.id}`).toBeLessThanOrEqual(
          1,
        );
      }
    });
  }
});
