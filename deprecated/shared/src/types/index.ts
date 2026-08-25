export * from './admin';
export * from './auto-approve';
export * from './auto-merge';
export * from './branching';
export * from './host-tools';
export * from './job-status';
export * from './usage';

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
