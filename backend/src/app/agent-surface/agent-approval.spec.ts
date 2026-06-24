import { describe, expect, it } from 'vitest';
import { DecisionApprovalService } from '../brain/decision-approval.service';
import type { DecisionApprovalCard } from '../surface';
import { AgentChatSurface } from './agent-chat-surface';

/**
 * The approval seam W9 scripts: Atlas posts the decision-record card through the AGENT surface; the
 * driver READS the card off the surface (parsing its jobId), then resolves the gate via the real
 * `DecisionApprovalService.resolve(...)` — and the brain's awaited verdict promise resolves. This
 * proves `AgentChatSurface` + `DecisionApprovalService` compose into a fully programmatic approve flow.
 */
describe('agent-facing approval simulation (AgentChatSurface + DecisionApprovalService)', () => {
  const card: DecisionApprovalCard = {
    jobId: 'job-1',
    decisionRecordId: 'dr-1',
    title: 'CSV export',
    summary: 'Add CSV export.',
    sections: ['Backend', 'Frontend'],
  };

  it('post card → read it off the surface → approve → the gate verdict resolves', async () => {
    const surface = new AgentChatSurface();
    const approvals = new DecisionApprovalService(surface);

    // The brain posts the card into the job's thread and awaits the verdict.
    const handle = await approvals.request({ channel: 'C1', threadTs: 'root.1' }, card);
    expect(handle.resolved).toBe(false);

    // The driver script reads the posted card off the surface (no Slack), grabs its jobId.
    const captured = surface.latestApprovalCard();
    expect(captured).toBeDefined();
    expect(captured!.jobId).toBe('job-1');
    expect(captured!.message.threadTs).toBe('root.1');

    // …and simulates the approve button by resolving the gate.
    const did = approvals.resolve(captured!.jobId, 'approve', 'U-DENNIS');
    expect(did).toBe(true);

    const verdict = await handle.verdict;
    expect(verdict).toEqual({ jobId: 'job-1', verdict: 'approve', ruledBy: 'U-DENNIS' });
  });

  it('waitForApprovalCard + request_changes resolves the gate with a note', async () => {
    const surface = new AgentChatSurface();
    const approvals = new DecisionApprovalService(surface);

    const waiting = surface.waitForApprovalCard(1000);
    const handle = await approvals.request({ channel: 'C1', threadTs: 'root.2' }, { ...card, jobId: 'job-2' });

    const captured = await waiting;
    expect(captured.jobId).toBe('job-2');

    approvals.resolve(captured.jobId, 'request_changes', 'U-DENNIS', 'use streaming');
    const verdict = await handle.verdict;
    expect(verdict.verdict).toBe('request_changes');
    expect(verdict.note).toBe('use streaming');
  });
});
