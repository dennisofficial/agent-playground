import { describe, expect, it, vi } from 'vitest';
import type { PlanStore } from '../../memory/plan-store';
import type { SessionRegistry } from '../../sessions/session-registry.port';
import type { HarnessToolContext } from '../tool.types';
import { SubmitPlanTool } from './submit-plan.tool';

/** One employee owns a ticket: submit_plan refuses a second planner's plan, but the same owner can
 * (re)submit a revision. */

const ctx = { identity: { selfAgent: 'alex' } } as unknown as HarnessToolContext;

function mk(existing: Array<{ employee: string }>) {
  const session = {
    id: 's1',
    ownerBot: 'alex',
    team: 'T1',
    status: 'idle',
    lastReportKind: 'plan',
    lastReport: 'PLAN TEXT',
    boardTaskId: 7,
  };
  const sessions = { get: async () => session } as unknown as SessionRegistry;
  const attach = vi.fn(async () => undefined);
  const plans = {
    listForTask: async () => existing,
    attach,
  } as unknown as PlanStore;
  return { tool: new SubmitPlanTool(sessions, plans), attach };
}

describe('submit_plan one-owner guard', () => {
  it('refuses when another employee already has a plan on the ticket', async () => {
    const { tool, attach } = mk([{ employee: 'riley' }]);
    const out = await tool.execute({ sessionId: 's1' }, ctx);
    expect(out).toContain('one owner per ticket');
    expect(attach).not.toHaveBeenCalled();
  });

  it('lets the same owner re-submit a revision', async () => {
    const { tool, attach } = mk([{ employee: 'alex' }]);
    await tool.execute({ sessionId: 's1' }, ctx);
    expect(attach).toHaveBeenCalled();
  });

  it('attaches when no plan exists yet', async () => {
    const { tool, attach } = mk([]);
    await tool.execute({ sessionId: 's1' }, ctx);
    expect(attach).toHaveBeenCalled();
  });
});
