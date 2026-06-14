import { MetricsEvent } from '@workspace/shared/schemas';
import type {
  IAgentMetricsSummary,
  IInternalMetricsResponse,
  IMetricsEventType,
} from '@workspace/shared';
import {
  Between,
  LessThanOrEqual,
  MoreThanOrEqual,
  type FindOperator,
  type FindOptionsWhere,
  type Repository,
} from 'typeorm';

// TODO: re-add public plan-lifecycle recorders when the Nest ticket board lands.
export interface IRecordMetricsEventInput {
  teamId: string;
  ticketId?: string | null;
  agentId?: string | null;
  projectId?: string | null;
  sessionId?: string | null;
  durationMs?: number | null;
  reason?: string | null;
  occurredAt?: Date;
  payload?: Record<string, unknown>;
}

export interface ISummarizeInternalMetricsInput {
  teamId: string;
  projectId?: string;
  since?: Date;
  until?: Date;
}

interface AgentAccumulator {
  agentId: string;
  executionCompleted: number;
  executionBlocked: number;
}

export class MetricsEventsService {
  constructor(private readonly events: Repository<MetricsEvent>) {}

  recordExecutionCompleted(input: IRecordMetricsEventInput) {
    return this.record('execution_completed', input);
  }

  recordExecutionBlocked(input: IRecordMetricsEventInput) {
    return this.record('execution_blocked', input);
  }

  async summarizeByAgent(
    input: ISummarizeInternalMetricsInput,
  ): Promise<IInternalMetricsResponse> {
    const events = await this.events.find({
      where: this.summaryWhere(input),
      order: { occurred_at: 'ASC', id: 'ASC' },
    });
    const byAgent = new Map<string, AgentAccumulator>();

    for (const event of events) {
      if (!event.agent_id) continue;

      if (event.event_type === 'execution_completed') {
        const agent = this.agentAccumulator(byAgent, event.agent_id);
        agent.executionCompleted++;
      } else if (event.event_type === 'execution_blocked') {
        const agent = this.agentAccumulator(byAgent, event.agent_id);
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
        .map((agent): IAgentMetricsSummary => {
          const executionAttempts =
            agent.executionCompleted + agent.executionBlocked;
          return {
            agentId: agent.agentId,
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
    eventType: IMetricsEventType,
    input: IRecordMetricsEventInput,
  ): Promise<MetricsEvent> {
    return this.events.save(
      this.events.create({
        team_id: input.teamId,
        event_type: eventType,
        ticket_id: input.ticketId ?? null,
        agent_id: input.agentId ?? null,
        project_id: input.projectId ?? null,
        session_id: input.sessionId ?? null,
        revision_number: null,
        duration_ms: input.durationMs ?? null,
        time_to_approval_ms: null,
        reason: input.reason ?? null,
        occurred_at: input.occurredAt ?? new Date(),
        payload: input.payload ?? {},
      }),
    );
  }

  private summaryWhere(
    input: ISummarizeInternalMetricsInput,
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
