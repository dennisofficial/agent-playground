import { describe, expect, it } from 'vitest';
import {
  APPROVE_ACTION_ID,
  DENY_ACTION_ID,
  VIEW_PLAN_ACTION_ID,
  decisionApprovalBlocks,
  verdictBlocks,
  type DecisionApprovalCard,
} from './approval-blocks';

const card: DecisionApprovalCard = {
  jobId: 'job-1',
  decisionRecordId: 'dr-1',
  title: 'Payments',
  summary: 'Use Stripe; add a webhooks table.',
  threads: ['backend: stripe client + webhooks', 'frontend: checkout page'],
};

describe('decisionApprovalBlocks', () => {
  it('renders headline, summary, numbered thread list, and verdict buttons', () => {
    const blocks = decisionApprovalBlocks(card);
    const json = JSON.stringify(blocks);
    expect(json).toContain('Plan proposal — Payments');
    expect(json).toContain('Use Stripe');
    expect(json).toContain('1. backend: stripe client + webhooks');
    expect(json).toContain('2. frontend: checkout page');
    const actions = blocks.find((b) => b.type === 'actions') as {
      elements: Array<{ action_id: string; value: string }>;
    };
    const ids = actions.elements.map((e) => e.action_id);
    expect(ids).toContain(APPROVE_ACTION_ID);
    expect(ids).toContain(DENY_ACTION_ID);
    // The button value carries the stateless ids.
    expect(JSON.parse(actions.elements[0].value)).toEqual({
      jobId: 'job-1',
      decisionRecordId: 'dr-1',
    });
  });

  it('renders the locked decisions when present, and omits the block when absent (issue #7)', () => {
    const withDecisions = decisionApprovalBlocks({
      ...card,
      decisions: [
        {
          decisionClass: 'dependency',
          title: 'JWT library',
          ruling: 'use jose',
        },
        {
          decisionClass: 'cross_cutting',
          title: 'Password hashing',
          ruling: 'argon2id',
        },
      ],
    });
    const json = JSON.stringify(withDecisions);
    expect(json).toContain('*Decisions*');
    expect(json).toContain('JWT library');
    expect(json).toContain('use jose');
    expect(json).toContain('argon2id');
    // No decisions → no Decisions block at all.
    expect(JSON.stringify(decisionApprovalBlocks(card))).not.toContain(
      '*Decisions*',
    );
  });

  it('adds a View-plan link button only when planUrl is given', () => {
    const without = decisionApprovalBlocks(card);
    const withUrl = decisionApprovalBlocks({
      ...card,
      planUrl: 'https://x/plan',
    });
    const idsOf = (bs: Array<Record<string, unknown>>) => {
      const a = bs.find((b) => b.type === 'actions') as {
        elements: Array<{ action_id: string }>;
      };
      return a.elements.map((e) => e.action_id);
    };
    expect(idsOf(without)).not.toContain(VIEW_PLAN_ACTION_ID);
    expect(idsOf(withUrl)).toContain(VIEW_PLAN_ACTION_ID);
  });

  it('verdictBlocks drops the action buttons and appends the verdict line', () => {
    const original = decisionApprovalBlocks(card);
    const ruled = verdictBlocks(original, 'Approved by Dennis');
    expect(ruled.some((b) => b.type === 'actions')).toBe(false);
    expect(JSON.stringify(ruled)).toContain('Approved by Dennis');
  });
});
