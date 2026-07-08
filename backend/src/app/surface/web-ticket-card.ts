/**
 * Web TICKET card payload — the durable transcript callout posted when the brain captures a ticket mid-job
 * via the `create_ticket` tool. Its job is to RELAY, in real time, that Atlas raised out-of-scope work on
 * the board the operator is watching (previously silent: the tool wrote the row + fired a board-refresh
 * `ticket_event`, but nothing landed in the job conversation). Purely informational — no approve/answer
 * lifecycle; the operator clicks through to the ticket on the board.
 *
 * Pure — no I/O, no NestJS. Mirrors `web-mcp-proposal-card.ts`. Built from the created `TicketEntity` at
 * capture time (see `BrainStoreService.appendTicketCard`).
 */
import type { TicketEntity } from '../persistence/entities';

/** A rendered ticket-captured card — posted to the surface transcript + persisted as a durable card row. */
export interface WebTicketCard {
  /** Discriminant — the web client checks `type` to decide which component to render. */
  type: 'ticket_card';
  /** The ticket's real uuid (for the board deep-link). */
  ticketId: string;
  /** Human-friendly per-repo number (#14). */
  number: number;
  title: string;
  /** `TicketKind | null` — 'feature' | 'bug' | 'chore'. */
  kind: string | null;
  /** `TicketPriority | null` — 'low' | 'medium' | 'high' | 'urgent'. */
  priority: string | null;
  /** `TicketStatus` — usually 'backlog' at capture. */
  status: string;
  /** One-line summary of the decision this ticket diverged from (from the immutable origin snapshot). */
  originDecisionSummary: string | null;
}

/** Build a `WebTicketCard` from a freshly-created ticket row. */
export function webTicketCard(t: TicketEntity): WebTicketCard {
  return {
    type: 'ticket_card',
    ticketId: t.id,
    number: t.number,
    title: t.title,
    kind: t.kind ?? null,
    priority: t.priority ?? null,
    status: t.status,
    originDecisionSummary: t.origin?.decisionSummary ?? null,
  };
}
