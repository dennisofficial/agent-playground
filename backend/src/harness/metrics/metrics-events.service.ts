import { MetricsEvent } from '@workspace/shared/schemas';
import type {
  AgentMetricsSummary,
  InternalMetricsResponse,
  MetricsEventType,
} from '@workspace/shared';
import {
  Between,
  LessThanOrEqual,
  MoreThanOrEqual,
  type FindOperator,
  type FindOptionsWhere,
  type Repository,
} from 'typeorm';

export interface RecordMetricsEventInput {
  teamId: string;
  ticketId?: string | null;
  agentId?: string | null;
  projectId?: string | null;
  sessionId?: string | null;
  revisionNumber?: number | null;
  durationMs?: number | null;
  timeToApprovalMs?: number | null;
  reason?: string | null;
  occurredAt?: Date;
  payload?: Record<string, unknown>;
}

export interface SummarizeInternalMetricsInput {
  teamId: string;
  projectId?: string;
  since?: Date;
  until?: Date;
}

interface AgentAccumulator {
  agentId: string;
  approvedPlans: number;
  approvedRevisionNumbers: number[];
  firstPassApprovals: number;
  executionCompleted: number;
  executionBlocked: number;
}

export class MetricsEventsService {
  constructor(private readonly events: Repository<MetricsEvent>) {}

  recordPlanSubmitted(input: RecordMetricsEventInput) {
    return this.record('plan_submitted', input);
  }

  recordPlanApproved(input: RecordMetricsEventInput) {
    return this.record('plan_approved', input);
  }

  recordPlanChangesRequested(input: RecordMetricsEventInput) {
    return this.record('plan_changes_requested', input);
  }

  recordExecutionCompleted(input: RecordMetricsEventInput) {
    return this.record('execution_completed', input);
  }

  recordExecutionBlocked(input: RecordMetricsEventInput) {
    return this.record('execution_blocked', input);
  }

  async summarizeByAgent(
    input: SummarizeInternalMetricsInput,
  ): Promise<InternalMetricsResponse> {
    const events = await this.events.find({
      where: this.summaryWhere(input),
      order: { occurred_at: 'ASC', id: 'ASC' },
    });
    const byAgent = new Map<string, AgentAccumulator>();

    for (const event of events) {
      if (!event.agent_id) continue;
      const agent = this.agentAccumulator(byAgent, event.agent_id);

      if (event.event_type === 'plan_approved') {
        agent.approvedPlans++;
        if (event.revision_number !== null) {
          agent.approvedRevisionNumbers.push(event.revision_number);
          if (event.revision_number === 0) agent.firstPassApprovals++;
        }
      } else if (event.event_type === 'execution_completed') {
        agent.executionCompleted++;
      } else if (event.event_type === 'execution_blocked') {
        agent.executionBlocked++;
      }
    }

    return {
      teamId: input.teamId,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.since ? { since: input.since.toISOString() } : {}),
      ...(input.until ? { until: input.until.toISOString() } : {}),
      generatedAt: new Date().toISOString(),
      agents: [...byAgent.values()]
        .map((agent): AgentMetricsSummary => {
          const executionAttempts =
            agent.executionCompleted + agent.executionBlocked;
          return {
            agentId: agent.agentId,
            approvedPlans: agent.approvedPlans,
            firstPassApprovals: agent.firstPassApprovals,
            firstPassApprovalRate:
              agent.approvedPlans === 0
                ? null
                : agent.firstPassApprovals / agent.approvedPlans,
            medianRevisionsBeforeApproval: median(
              agent.approvedRevisionNumbers,
            ),
            executionCompleted: agent.executionCompleted,
            executionBlocked: agent.executionBlocked,
            executionSuccessRate:
              executionAttempts === 0
                ? null
                : agent.executionCompleted / executionAttempts,
          };
        })
        .sort((a, b) => a.agentId.localeCompare(b.agentId)),
    };
  }

  private async record(
    eventType: MetricsEventType,
    input: RecordMetricsEventInput,
  ): Promise<MetricsEvent> {
    return this.events.save(
      this.events.create({
        team_id: input.teamId,
        event_type: eventType,
        ticket_id: input.ticketId ?? null,
        agent_id: input.agentId ?? null,
        project_id: input.projectId ?? null,
        session_id: input.sessionId ?? null,
        revision_number: input.revisionNumber ?? null,
        duration_ms: input.durationMs ?? null,
        time_to_approval_ms: input.timeToApprovalMs ?? null,
        reason: input.reason ?? null,
        occurred_at: input.occurredAt ?? new Date(),
        payload: input.payload ?? {},
      }),
    );
  }

  private summaryWhere(
    input: SummarizeInternalMetricsInput,
  ): FindOptionsWhere<MetricsEvent> {
    return {
      team_id: input.teamId,
      ...(input.projectId ? { project_id: input.projectId } : {}),
      ...dateWhere(input.since, input.until),
    };
  }

  private agentAccumulator(
    byAgent: Map<string, AgentAccumulator>,
    agentId: string,
  ): AgentAccumulator {
    const existing = byAgent.get(agentId);
    if (existing) return existing;
    const created: AgentAccumulator = {
      agentId,
      approvedPlans: 0,
      approvedRevisionNumbers: [],
      firstPassApprovals: 0,
      executionCompleted: 0,
      executionBlocked: 0,
    };
    byAgent.set(agentId, created);
    return created;
  }
}

function dateWhere(
  since?: Date,
  until?: Date,
): { occurred_at?: FindOperator<Date> } {
  if (since && until) return { occurred_at: Between(since, until) };
  if (since) return { occurred_at: MoreThanOrEqual(since) };
  if (until) return { occurred_at: LessThanOrEqual(until) };
  return {};
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}
