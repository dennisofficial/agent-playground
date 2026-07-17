
import type { ApprovalDecision, DecisionApprovalCard } from './approval-blocks';
import {
  AMEND_APPROVE_ACTION_ID,
  AMEND_DISMISS_ACTION_ID,
  APPROVE_ACTION_ID,
  DB_WRITE_APPROVE_ACTION_ID,
  DB_WRITE_DENY_ACTION_ID,
  DENY_ACTION_ID,
  MERGE_ACTION_ID,
  RETRACT_SHIP_ACTION_ID,
  SHIP_ACTION_ID,
  VIEW_PLAN_ACTION_ID,
} from './approval-blocks';

export interface ShipThreadVerification {
  title: string;
  status: 'done' | 'not_done';
  verification: {
    kind: string;
    command: string;
    exitCode: number;
    outputTail: string;
  }[];
  unverified: boolean;
}

export interface WebCardAction {
  actionId: string;
  label: string;
  style: 'primary' | 'danger' | 'default';
  url?: string;
  value: string;
}

export interface WebApprovalCard {
  type: 'approval_card';
  jobId: string;
  decisionRecordId?: string;
  kind?: 'plan' | 'direct' | 'ship' | 'amend' | 'merge' | 'db_write';
  title: string;
  summary: string;
  decisions: ApprovalDecision[];
  threads: string[];
  planUrl?: string;
  actions: WebCardAction[];
  previewRequestedAt?: string;
  verifications?: ShipThreadVerification[];
  sql?: string;
  estimatedRows?: number;
  estimateLabel?: 'estimate' | 'unavailable' | 'error';
  error?: string;
}

export interface WebVerdictCard {
  type: 'verdict_card';
  jobId: string;
  title: string;
  verdict: string;
  verdictLine: string;
}

export function webApprovalCard(card: DecisionApprovalCard): WebApprovalCard {
  const value = JSON.stringify({
    jobId: card.jobId,
    ...(card.decisionRecordId ? { decisionRecordId: card.decisionRecordId } : {}),
  });

  const actions: WebCardAction[] = [];

  if (card.planUrl) {
    actions.push({
      actionId: VIEW_PLAN_ACTION_ID,
      label: 'View full plan',
      style: 'default',
      url: card.planUrl,
      value,
    });
  }

  actions.push(
    {
      actionId: APPROVE_ACTION_ID,
      label: 'Approve',
      style: 'primary',
      value,
    },
    {
      actionId: DENY_ACTION_ID,
      label: 'Deny',
      style: 'danger',
      value,
    },
  );

  return {
    type: 'approval_card',
    jobId: card.jobId,
    ...(card.decisionRecordId ? { decisionRecordId: card.decisionRecordId } : {}),
    ...(card.kind ? { kind: card.kind } : {}),
    title: card.title,
    summary: card.summary,
    decisions: card.decisions ?? [],
    threads: card.threads,
    ...(card.planUrl ? { planUrl: card.planUrl } : {}),
    actions,
  };
}

export function webShipReviewCard(input: {
  jobId: string;
  title: string;
  summary: string;
  verifications?: ShipThreadVerification[];
}): WebApprovalCard {
  const value = JSON.stringify({ jobId: input.jobId });
  return {
    type: 'approval_card',
    jobId: input.jobId,
    kind: 'ship',
    title: input.title,
    summary: input.summary,
    decisions: [],
    threads: [],
    ...(input.verifications?.length ? { verifications: input.verifications } : {}),
    actions: [
      {
        actionId: SHIP_ACTION_ID,
        label: 'Ship it',
        style: 'primary',
        value,
      },
      {
        actionId: RETRACT_SHIP_ACTION_ID,
        label: 'Amend build',
        style: 'default',
        value,
      },
    ],
  };
}

export function webMergeReadyCard(jobId: string): WebApprovalCard {
  const value = JSON.stringify({ jobId });
  return {
    type: 'approval_card',
    jobId,
    kind: 'merge',
    title: 'Merge PR',
    summary: 'This PR is ready to merge.',
    decisions: [],
    threads: [],
    actions: [
      {
        actionId: MERGE_ACTION_ID,
        label: 'Merge PR',
        style: 'primary',
        value,
      },
    ],
  };
}

export function webAmendProposalCard(input: { jobId: string; reason: string }): WebApprovalCard {
  const value = JSON.stringify({ jobId: input.jobId });
  return {
    type: 'approval_card',
    jobId: input.jobId,
    kind: 'amend',
    title: 'Amend build?',
    summary: input.reason,
    decisions: [],
    threads: [],
    actions: [
      {
        actionId: AMEND_APPROVE_ACTION_ID,
        label: 'Approve amend',
        style: 'primary',
        value,
      },
      {
        actionId: AMEND_DISMISS_ACTION_ID,
        label: 'Dismiss',
        style: 'default',
        value,
      },
    ],
  };
}

export function webDbWriteApprovalCard(input: {
  jobId: string;
  writeId: string;
  sql: string;
  estimatedRows?: number;
  estimateLabel?: 'estimate' | 'unavailable' | 'error';
  error?: string;
}): WebApprovalCard {
  const value = JSON.stringify({ jobId: input.jobId, writeId: input.writeId });
  const estimateLine = input.error
    ? `:warning: This statement failed its dry-run and will likely fail on execute:\n\n\`\`\`\n${input.error}\n\`\`\``
    : `Estimated rows affected: ${input.estimatedRows ?? 'unavailable'}`;
  return {
    type: 'approval_card',
    jobId: input.jobId,
    kind: 'db_write',
    title: 'Approve prod DB write',
    summary: `\n\n\`\`\`sql\n${input.sql}\n\`\`\`\n\n${estimateLine}`,
    decisions: [],
    threads: [],
    sql: input.sql,
    ...(input.estimatedRows !== undefined ? { estimatedRows: input.estimatedRows } : {}),
    ...(input.estimateLabel ? { estimateLabel: input.estimateLabel } : {}),
    ...(input.error ? { error: input.error } : {}),
    actions: [
      {
        actionId: DB_WRITE_APPROVE_ACTION_ID,
        label: 'Execute write',
        style: 'danger',
        value,
      },
      {
        actionId: DB_WRITE_DENY_ACTION_ID,
        label: 'Deny',
        style: 'default',
        value,
      },
    ],
  };
}

export function webVerdictCard(
  jobId: string,
  title: string,
  verdict: string,
  verdictLine: string,
): WebVerdictCard {
  return { type: 'verdict_card', jobId, title, verdict, verdictLine };
}

export function parseWebApprovalMeta(
  value: string,
): { jobId: string; decisionRecordId?: string } | undefined {
  try {
    const meta = JSON.parse(value) as Record<string, unknown>;
    if (meta && typeof meta.jobId === 'string') {
      return {
        jobId: meta.jobId,
        ...(typeof meta.decisionRecordId === 'string'
          ? { decisionRecordId: meta.decisionRecordId }
          : {}),
      };
    }
  } catch {
  }
  return undefined;
}
