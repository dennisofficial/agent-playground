// Shared TypeScript types (Employee, ConductorEvent, job-update payloads,
// identity/scope types). Populated during the harness-migration pass.
export * from './admin';
export * from './branching';
export * from './job-status';

export type IMetricsEventType =
  | 'plan_submitted'
  | 'plan_approved'
  | 'plan_changes_requested'
  | 'execution_completed'
  | 'execution_blocked';

export interface IAgentMetricsSummary {
  agentId: string;
  executionCompleted: number;
  executionBlocked: number;
  executionSuccessRate: number | null;
}

export interface IInternalMetricsQuery {
  projectId?: string;
  since?: string;
  until?: string;
}

export interface IInternalMetricsResponse {
  teamId: string;
  projectId?: string;
  since?: string;
  until?: string;
  generatedAt: string;
  agents: IAgentMetricsSummary[];
}
