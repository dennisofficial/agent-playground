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

/**
 * One build thread's SELF-REPORTED verification, surfaced verbatim on the ship-review card (d5). No judge
 * grades it: `unverified` just flags a thread that asserted done with zero evidence, so the operator knows
 * to eyeball it. A verbatim passthrough of `terminal_record.verification` — the human ship-review + CI are
 * the real backstops.
 */
export interface ShipThreadVerification {
  /** The build thread's title/brief. */
  title: string;
  /** Whether this thread asserted completion; `not_done` is advisory on the ship card (master_review only). */
  status: 'done' | 'not_done';
  /** The thread's captured verification evidence (command + exit code + output tail). */
  verification: {
    kind: string;
    command: string;
    exitCode: number;
    outputTail: string;
  }[];
  /** The thread asserted done but reported no verification evidence at all. */
  unverified: boolean;
}

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
   * - `ship` — the ship-review gate (`Ship it` + `Amend build`; `threads`/`decisions` empty).
   * - `amend` — the brain's "Amend build?" PROPOSAL at the ship gate (`Approve amend` + `Dismiss`); the
   *   gate stays parked until the operator approves. `threads`/`decisions` empty.
   * - `merge` — the merge-ready gate (`Merge PR`); posted once the PR is GitHub-mergeable, regardless of
   *   auto-merge. `threads`/`decisions` empty.
   * - `db_write` — the `atlas-prod` gated-write approval card (Thread 2): `Execute write` + `Deny`;
   *   `threads`/`decisions` empty, the proposed statement rides `sql`/`estimatedRows`/`estimateLabel`.
   * The web labels the list "Sections" vs "Changes"; a `ship`/`amend`/`merge`/`db_write` card renders its
   * actions generically.
   */
  kind?: 'plan' | 'direct' | 'ship' | 'amend' | 'merge' | 'db_write';
  title: string;
  summary: string;
  decisions: ApprovalDecision[];
  threads: string[];
  planUrl?: string;
  actions: WebCardAction[];
  /** ISO timestamp stamped when the operator clicks "Spin up preview" at the ship gate — hides the button. */
  previewRequestedAt?: string;
  /** `ship` card only — each build thread's self-reported verification evidence (d5). Verbatim passthrough,
   *  no judge; Thread 2 renders it so the operator reviews the honest signal before shipping. */
  verifications?: ShipThreadVerification[];
  /** `db_write` card only — the exact proposed single SQL statement. */
  sql?: string;
  /** `db_write` card only — the EXPLAIN-estimated row count, when available. */
  estimatedRows?: number;
  /** `db_write` card only — whether `estimatedRows` is a real planner estimate, unavailable (the
   *  SELECT-only role can't EXPLAIN this statement — expected/benign for DML), or the EXPLAIN itself
   *  surfaced a genuine statement error (`error`). */
  estimateLabel?: 'estimate' | 'unavailable' | 'error';
  /** `db_write` card only — a genuine EXPLAIN-time failure (syntax/bad column) so the operator sees the
   *  statement will fail BEFORE approving. Absent for a benign permission-denied preview. */
  error?: string;
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
    ...(card.decisionRecordId
      ? { decisionRecordId: card.decisionRecordId }
      : {}),
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
    ...(card.decisionRecordId
      ? { decisionRecordId: card.decisionRecordId }
      : {}),
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
 * (no decision record: ship resumes the driver; retract sends the job to `amending`). Reuses the
 * `approval_card` payload type (so the web's inline card renderer needs no new branch — it renders
 * `actions` generically), discriminated by `kind: 'ship'`.
 */
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
    ...(input.verifications?.length
      ? { verifications: input.verifications }
      : {}),
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

/**
 * Build the MERGE-READY gate card — posted once a PR is GitHub-mergeable (see `prMergeReady`), regardless
 * of the job's `auto_merge` toggle: a human can always click `Merge PR`. A single primary action, so
 * unlike `webShipReviewCard` there's no secondary button. Discriminated by `kind: 'merge'`.
 */
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

/**
 * Build the brain's "Amend build?" PROPOSAL card — posted by `withdraw_ship` while the job is parked at
 * the ship-review gate. Unlike `webShipReviewCard`, this does NOT retract on its own: it asks the operator
 * to approve amending. `Approve amend` runs the operator retract path + wakes the brain; `Dismiss` leaves
 * the gate parked. Reuses the `approval_card` payload (generic `actions` renderer), discriminated by
 * `kind: 'amend'`. Its action values carry only `{ jobId }`.
 */
export function webAmendProposalCard(input: {
  jobId: string;
  reason: string;
}): WebApprovalCard {
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

/**
 * Build the `atlas-prod` gated-write approval card — posted by `ProdDiagnosticsService.proposeWrite` for
 * the operator to rule on. Its action `value` carries `{ jobId, writeId }` (the `prod_maintenance_write`
 * row id), NOT a decision record — `Execute write` runs the exact proposed statement on the DML-only
 * `mcp_writer` role, `Deny` marks the row `rejected`. Reuses the `approval_card` payload (generic
 * `actions` renderer), discriminated by `kind: 'db_write'`; the SQL + estimate also ride as first-class
 * fields for the web's monospace `DbWriteCardView`.
 */
export function webDbWriteApprovalCard(input: {
  jobId: string;
  writeId: string;
  sql: string;
  estimatedRows?: number;
  estimateLabel?: 'estimate' | 'unavailable' | 'error';
  error?: string;
}): WebApprovalCard {
  const value = JSON.stringify({ jobId: input.jobId, writeId: input.writeId });
  // A genuine EXPLAIN failure (syntax/bad column) is surfaced IN the rendered summary — not just a
  // structured field — so the operator is warned the statement will fail before clicking Execute.
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
    ...(input.estimatedRows !== undefined
      ? { estimatedRows: input.estimatedRows }
      : {}),
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
        ...(typeof meta.decisionRecordId === 'string'
          ? { decisionRecordId: meta.decisionRecordId }
          : {}),
      };
    }
  } catch {
    // not our payload
  }
  return undefined;
}
