// Shared TypeScript types (Employee, ConductorEvent, job-update payloads,
// identity/scope types).

export type MetricsEventType =
  | 'plan_submitted'
  | 'plan_approved'
  | 'plan_changes_requested'
  | 'execution_completed'
  | 'execution_blocked';

export interface AgentMetricsSummary {
  agentId: string;
  approvedPlans: number;
  firstPassApprovals: number;
  firstPassApprovalRate: number | null;
  medianRevisionsBeforeApproval: number | null;
  executionCompleted: number;
  executionBlocked: number;
  executionSuccessRate: number | null;
}

export interface InternalMetricsQuery {
  projectId?: string;
  since?: string;
  until?: string;
}

export interface InternalMetricsResponse {
  teamId: string;
  projectId?: string;
  since?: string;
  until?: string;
  generatedAt: string;
  agents: AgentMetricsSummary[];
}
