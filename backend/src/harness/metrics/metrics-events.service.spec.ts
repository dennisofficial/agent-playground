import { MetricsEvent } from '@workspace/shared/schemas';
import { Between, type Repository } from 'typeorm';
import { MetricsEventsService } from './metrics-events.service';

function event(
  patch: Partial<MetricsEvent> & Pick<MetricsEvent, 'event_type' | 'agent_id'>,
): MetricsEvent {
  return {
    id: 1,
    team_id: 'T1',
    event_type: patch.event_type,
    ticket_id: null,
    agent_id: patch.agent_id,
    project_id: 'proj',
    session_id: null,
    revision_number: null,
    duration_ms: null,
    time_to_approval_ms: null,
    reason: null,
    occurred_at: new Date('2026-01-01T00:00:00.000Z'),
    payload: {},
    ...patch,
  };
}

function buildService(events: MetricsEvent[] = []) {
  const saved: MetricsEvent[] = [];
  const find = vi.fn(async (_options?: unknown) => events);
  const repo = {
    create: vi.fn((input: Partial<MetricsEvent>) => input as MetricsEvent),
    save: vi.fn(async (input: MetricsEvent) => {
      const savedEvent = { ...input, id: saved.length + 1 };
      saved.push(savedEvent);
      return savedEvent;
    }),
    find,
  } as unknown as Repository<MetricsEvent>;

  return { service: new MetricsEventsService(repo), repo, saved, find };
}

describe('MetricsEventsService', () => {
  it('records append-only metrics events with typed dimensions', async () => {
    const { service, saved } = buildService();

    await service.recordExecutionCompleted({
      teamId: 'T1',
      agentId: 'alex',
      projectId: 'proj',
      sessionId: 'sess-001',
      durationMs: 1250,
      payload: { turn: 2 },
    });

    expect(saved).toEqual([
      expect.objectContaining({
        team_id: 'T1',
        event_type: 'execution_completed',
        agent_id: 'alex',
        project_id: 'proj',
        session_id: 'sess-001',
        duration_ms: 1250,
        payload: { turn: 2 },
      }),
    ]);
    expect(saved[0].occurred_at).toBeInstanceOf(Date);
  });

  it('summarizes first-pass approvals, median revisions, and execution success per agent', async () => {
    const { service, find } = buildService([
      event({
        agent_id: 'alex',
        event_type: 'plan_approved',
        revision_number: 0,
      }),
      event({
        agent_id: 'alex',
        event_type: 'plan_approved',
        revision_number: 2,
      }),
      event({ agent_id: 'alex', event_type: 'execution_completed' }),
      event({ agent_id: 'alex', event_type: 'execution_blocked' }),
      event({ agent_id: 'alex', event_type: 'execution_completed' }),
      event({
        agent_id: 'riley',
        event_type: 'plan_approved',
        revision_number: 1,
      }),
      event({ agent_id: 'riley', event_type: 'execution_blocked' }),
      event({ agent_id: null, event_type: 'execution_completed' }),
    ]);

    const since = new Date('2026-01-01T00:00:00.000Z');
    const until = new Date('2026-01-31T23:59:59.999Z');

    const summary = await service.summarizeByAgent({
      teamId: 'T1',
      projectId: 'proj',
      since,
      until,
    });

    expect(find).toHaveBeenCalledWith({
      where: {
        team_id: 'T1',
        project_id: 'proj',
        occurred_at: Between(since, until),
      },
      order: { occurred_at: 'ASC', id: 'ASC' },
    });
    expect(summary).toEqual({
      teamId: 'T1',
      projectId: 'proj',
      since: '2026-01-01T00:00:00.000Z',
      until: '2026-01-31T23:59:59.999Z',
      generatedAt: expect.any(String),
      agents: [
        {
          agentId: 'alex',
          approvedPlans: 2,
          firstPassApprovals: 1,
          firstPassApprovalRate: 0.5,
          medianRevisionsBeforeApproval: 1,
          executionCompleted: 2,
          executionBlocked: 1,
          executionSuccessRate: 2 / 3,
        },
        {
          agentId: 'riley',
          approvedPlans: 1,
          firstPassApprovals: 0,
          firstPassApprovalRate: 0,
          medianRevisionsBeforeApproval: 1,
          executionCompleted: 0,
          executionBlocked: 1,
          executionSuccessRate: 0,
        },
      ],
    });
  });

  it('computes even-number median from sorted non-adjacent revision values', async () => {
    const { service } = buildService([
      event({
        agent_id: 'alex',
        event_type: 'plan_approved',
        revision_number: 10,
      }),
      event({
        agent_id: 'alex',
        event_type: 'plan_approved',
        revision_number: 0,
      }),
      event({
        agent_id: 'alex',
        event_type: 'plan_approved',
        revision_number: 8,
      }),
      event({
        agent_id: 'alex',
        event_type: 'plan_approved',
        revision_number: 2,
      }),
    ]);

    const summary = await service.summarizeByAgent({ teamId: 'T1' });

    expect(summary.agents).toEqual([
      expect.objectContaining({
        agentId: 'alex',
        approvedPlans: 4,
        firstPassApprovals: 1,
        firstPassApprovalRate: 0.25,
        medianRevisionsBeforeApproval: 5,
      }),
    ]);
  });

  it('returns null execution success rate when an agent has no execution attempts', async () => {
    const { service } = buildService([
      event({
        agent_id: 'alex',
        event_type: 'plan_approved',
        revision_number: 1,
      }),
    ]);

    const summary = await service.summarizeByAgent({ teamId: 'T1' });

    expect(summary.agents).toEqual([
      expect.objectContaining({
        agentId: 'alex',
        executionCompleted: 0,
        executionBlocked: 0,
        executionSuccessRate: null,
      }),
    ]);
  });

  it('returns null first-pass approval rate when an agent has no approvals with revisions', async () => {
    const { service } = buildService([
      event({ agent_id: 'alex', event_type: 'execution_completed' }),
    ]);

    const summary = await service.summarizeByAgent({ teamId: 'T1' });

    expect(summary.agents).toEqual([
      expect.objectContaining({
        agentId: 'alex',
        approvedPlans: 0,
        firstPassApprovals: 0,
        firstPassApprovalRate: null,
        medianRevisionsBeforeApproval: null,
      }),
    ]);
  });

  it('excludes null and missing revision numbers from approval math', async () => {
    const missingRevision = event({
      agent_id: 'alex',
      event_type: 'plan_approved',
    });
    missingRevision.revision_number = undefined as unknown as number | null;
    const { service } = buildService([
      event({
        agent_id: 'alex',
        event_type: 'plan_approved',
        revision_number: null,
      }),
      missingRevision,
      event({
        agent_id: 'alex',
        event_type: 'plan_approved',
        revision_number: 0,
      }),
    ]);

    const summary = await service.summarizeByAgent({ teamId: 'T1' });

    expect(summary.agents).toEqual([
      expect.objectContaining({
        agentId: 'alex',
        approvedPlans: 1,
        firstPassApprovals: 1,
        firstPassApprovalRate: 1,
        medianRevisionsBeforeApproval: 0,
      }),
    ]);
  });
});
