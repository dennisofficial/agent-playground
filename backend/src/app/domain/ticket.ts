/**
 * The TICKET model — Atlas's internal board + backlog. A ticket is a durable, lightweight unit of
 * captured intent that lives on a repo, INDEPENDENT of the heavy thread/sandbox machinery. It's how
 * out-of-scope work surfaced mid-conversation ("do A now, push B for later") becomes a record Atlas
 * can act on later, rather than something the operator has to remember.
 *
 * A ticket is NOT a thread: threads own a sandbox/worktree/feature-branch/PR; a ticket is just intent.
 * When a ticket is picked up it is PROMOTED into a thread (one thread works one ticket — see the
 * `threads.ticket_id` link). The board is per-repo (mirrors threads); org-wide views are a UI
 * aggregation over the denormalized `org_id`.
 *
 * Dependencies are ADVISORY: "blocked by" edges + a derived `blocked` flag inform humans/Atlas, but
 * nothing auto-promotes when a blocker resolves (poll-based auto-unblock was tried for threads and
 * removed as too fragile). These are the in-memory shapes; the rows live in `tickets` /
 * `ticket_dependencies` / `ticket_counters`.
 */

/**
 * A ticket's board column. `backlog` is the triage holding pen (newly captured / not yet committed
 * to the active board); the rest are the board lanes a picked-up ticket moves through.
 */
export type TicketStatus =
  | 'backlog' // captured, triage holding pen — not on the active board yet
  | 'todo' // committed to the board, not started
  | 'in_progress' // actively being worked (typically has a linked thread)
  | 'in_review' // work done, under review (e.g. a PR is open)
  | 'done'
  | 'cancelled';

export type TicketPriority = 'low' | 'medium' | 'high' | 'urgent';

export type TicketKind = 'feature' | 'bug' | 'chore';

export const TICKET_STATUSES: readonly TicketStatus[] = [
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'done',
  'cancelled',
];

export const TICKET_PRIORITIES: readonly TicketPriority[] = ['low', 'medium', 'high', 'urgent'];

export const TICKET_KINDS: readonly TicketKind[] = ['feature', 'bug', 'chore'];

/** Statuses that DON'T block a dependent — a ticket is `blocked` only by deps not yet in one of these. */
export const TICKET_TERMINAL_STATUSES: ReadonlySet<TicketStatus> = new Set<TicketStatus>([
  'done',
  'cancelled',
]);

/**
 * Semantic-dedup similarity thresholds (cosine similarity to the candidate's `title\n\nbody`; 1 =
 * identical). `TICKET_SIMILAR_SIM` is the floor for SURFACING a "related" candidate to a human/agent
 * who then decides (the brain's confirm-gate + the web create panel). `TICKET_AUTO_SKIP_SIM` is the
 * higher bar at which the builder — which has NO human in the loop — silently collapses a capture into
 * an existing OPEN ticket rather than filing a near-duplicate. Tunable.
 */
export const TICKET_SIMILAR_SIM = 0.6;
export const TICKET_AUTO_SKIP_SIM = 0.82;

/** A near-neighbour surfaced by embedding dedup: the candidate ticket plus its cosine similarity. */
export interface TicketSimilarItem {
  id: string;
  number: number;
  title: string;
  status: TicketStatus;
  kind: TicketKind | null;
  priority: TicketPriority | null;
  /** Cosine similarity to the query text (1 = identical). */
  sim: number;
}

/**
 * Allow-list validators — shared by the HTTP DTO layer AND the brain tools so status/priority/kind are
 * never persisted unvalidated (a `text` column accepts anything; these are the only valid values).
 */
export function isTicketStatus(v: unknown): v is TicketStatus {
  return typeof v === 'string' && (TICKET_STATUSES as readonly string[]).includes(v);
}

export function isTicketPriority(v: unknown): v is TicketPriority {
  return typeof v === 'string' && (TICKET_PRIORITIES as readonly string[]).includes(v);
}

export function isTicketKind(v: unknown): v is TicketKind {
  return typeof v === 'string' && (TICKET_KINDS as readonly string[]).includes(v);
}

/**
 * Immutable provenance snapshot, copied onto the ticket at creation. The live FKs (`origin_job_id`,
 * `origin_decision_record_id`) go `SET NULL` if the source thread/decision is deleted, so we ALSO keep
 * this human-readable snapshot so a ticket stays interpretable ("captured from …") regardless.
 */
export interface TicketOrigin {
  /** Display title of the thread the ticket was captured from (at capture time). */
  threadTitle?: string;
  /** One-line summary of the decision the ticket diverged from (at capture time). */
  decisionSummary?: string;
}

/** A ticket — captured intent on a repo's board. In-memory shape (the row is `TicketEntity`). */
export interface Ticket {
  id: string;
  orgId: string;
  repoId: string;
  /** Human-friendly per-repo number (#14). */
  number: number;
  title: string;
  body: string | null;
  status: TicketStatus;
  priority: TicketPriority | null;
  kind: TicketKind | null;
  /** Drag-order within a board column (ascending). */
  sortOrder: number;
  /** The thread this ticket was captured from (null if none / source deleted). */
  originThreadId: string | null;
  /** The decision record this ticket diverged from (null if none / source deleted). */
  originDecisionRecordId: string | null;
  origin: TicketOrigin | null;
  createdAt: Date;
  updatedAt: Date;
}
