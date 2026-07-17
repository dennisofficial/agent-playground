import { describe, expect, it } from 'vitest';
import { DecisionApprovalService } from '../../brain/decision-approval.service';
import type { DecisionApprovalCard } from '../../surface';
import { AgentChatSurface } from '../agent-chat-surface';

describe('agent-facing approval simulation (AgentChatSurface + DecisionApprovalService)', () => {
  const card: DecisionApprovalCard = {
    jobId: 'job-1',
    decisionRecordId: 'dr-1',
    title: 'CSV export',
    summary: 'Add CSV export.',
    threads: ['Backend', 'Frontend'],
  };

  it('post card → read it off the surface → approve → the gate verdict resolves', async () => {
    const surface = new AgentChatSurface();
    const approvals = new DecisionApprovalService(surface);

    const handle = await approvals.request({ channel: 'C1', threadTs: 'root.1' }, card);
    expect(handle.resolved).toBe(false);

    const captured = surface.latestApprovalCard();
    expect(captured).toBeDefined();
    expect(captured!.jobId).toBe('job-1');
    expect(captured!.message.threadTs).toBe('root.1');

    const did = approvals.resolve(captured!.jobId, 'approve', 'U-DENNIS');
    expect(did).toBe(true);

    const verdict = await handle.verdict;
    expect(verdict).toEqual({
      jobId: 'job-1',
      verdict: 'approve',
      ruledBy: 'U-DENNIS',
    });
  });

  it('waitForApprovalCard + request_changes resolves the gate with a note', async () => {
    const surface = new AgentChatSurface();
    const approvals = new DecisionApprovalService(surface);

    const waiting = surface.waitForApprovalCard(1000);
    const handle = await approvals.request(
      { channel: 'C1', threadTs: 'root.2' },
      { ...card, jobId: 'job-2' },
    );

    const captured = await waiting;
    expect(captured.jobId).toBe('job-2');

    approvals.resolve(captured.jobId, 'request_changes', 'U-DENNIS', 'use streaming');
    const verdict = await handle.verdict;
    expect(verdict.verdict).toBe('request_changes');
    expect(verdict.note).toBe('use streaming');
  });
});
