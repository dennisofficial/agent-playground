/**
 * Web card payload builder — adapts the Slack Block Kit `approval-blocks.ts` domain shapes into a
 * JSON payload the web client renders. The domain types (`DecisionApprovalCard`, `ApprovalDecision`,
 * `ApprovalActionMeta`) are UNCHANGED; only the output format differs (a typed object the web UI
 * reads, not a Block Kit array). The action id constants are imported (not re-exported) to avoid
 * duplicate exports in `surface/index.ts` — consumers import them from `./approval-blocks` directly.
 *
 * Pure — no I/O, no NestJS. Zero v1 imports.
 */

import type { DecisionApprovalCard, ApprovalDecision } from './approval-blocks';
import {
  APPROVE_ACTION_ID,
  DENY_ACTION_ID,
  RETRACT_SHIP_ACTION_ID,
  SHIP_ACTION_ID,
  VIEW_PLAN_ACTION_ID,
} from './approval-blocks';

/** A single action button in the web card. */
export interface WebCardAction {
  actionId: string;
  label: string;
  style: 'primary' | 'danger' | 'default';
  /** A URL to open (link buttons — e.g. "View full plan"). When set, clicks navigate rather than POST. */
  url?: string;
  /** The serialised `ApprovalActionMeta` value — the client sends this back verbatim on the verdict endpoint. */
  value: string;
}

/** A rendered web approval card — the JSON payload posted to the web surface's SSE / REST transcript. */
export interface WebApprovalCard {
  /** Discriminant — the web client checks `type` to decide which component to render. */
  type: 'approval_card';
  jobId: string;
  decisionRecordId?: string;
  /**
   * Which gate the card is for:
   * - `plan` (full ceremony) / `direct` (fast path) — the plan-stage approval (Approve/Deny buttons).
   * - `ship` — the ship-review gate (`Ship it` + `Back to building`; `threads`/`decisions` empty).
   * The web labels the list "Sections" vs "Changes"; a `ship` card renders ship-gate actions.
   */
  kind?: 'plan' | 'direct' | 'ship';
  title: string;
  summary: string;
  decisions: ApprovalDecision[];
  threads: string[];
  planUrl?: string;
  actions: WebCardAction[];
}

/** A web-rendered verdict card — replaces the approval card after a verdict lands. */
export interface WebVerdictCard {
  type: 'verdict_card';
  jobId: string;
  title: string;
  verdict: string;
  verdictLine: string;
}

/**
 * Build the web card payload from a `DecisionApprovalCard`. Mirrors `decisionApprovalBlocks` in
 * structure and domain semantics — the same jobId/decisionRecordId ride in every action's `value` so
 * a verdict POST carries the same correlation ids the Slack interactivity handler reads.
 */
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

/**
 * Build the SHIP-REVIEW gate card — the terminal human gate. Its action values carry only `{ jobId }`
 * (no decision record: ship resumes the driver; retract sends the job back to planning). Reuses the
 * `approval_card` payload type (so the web's inline card renderer needs no new branch — it renders
 * `actions` generically), discriminated by `kind: 'ship'`.
 */
export function webShipReviewCard(input: {
  jobId: string;
  title: string;
  summary: string;
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
    actions: [
      {
        actionId: SHIP_ACTION_ID,
        label: 'Ship it',
        style: 'primary',
        value,
      },
      {
        actionId: RETRACT_SHIP_ACTION_ID,
        label: 'Back to building',
        style: 'default',
        value,
      },
    ],
  };
}

/**
 * Build the web verdict card that replaces the approval card after a ruling.
 * Mirrors `verdictBlocks` semantics — it replaces / updates the original card.
 */
export function webVerdictCard(
  jobId: string,
  title: string,
  verdict: string,
  verdictLine: string,
): WebVerdictCard {
  return { type: 'verdict_card', jobId, title, verdict, verdictLine };
}

/**
 * Parse `ApprovalActionMeta` from a web card payload's action value (the string the web client
 * sends back on a verdict). Mirrors `parseApprovalMeta` for Block Kit blocks — same correlation ids.
 */
export function parseWebApprovalMeta(
  value: string,
): { jobId: string; decisionRecordId?: string } | undefined {
  try {
    const meta = JSON.parse(value) as Record<string, unknown>;
    if (meta && typeof meta.jobId === 'string') {
      return {
        jobId: meta.jobId,
        ...(typeof meta.decisionRecordId === 'string' ? { decisionRecordId: meta.decisionRecordId } : {}),
      };
    }
  } catch {
    // not our payload
  }
  return undefined;
}
