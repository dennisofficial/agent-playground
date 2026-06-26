import { Injectable } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';

/** A board mutation — fanned out so the per-repo SSE stream can push live ticket changes to clients. */
export interface TicketEvent {
  type: 'ticket_event';
  orgId: string;
  repoId: string;
  ticketId: string;
  kind: 'created' | 'updated' | 'deleted';
}

/**
 * Realtime fan-out for board mutations. `TicketService` publishes on every create/update/delete; the
 * web surface merges `stream$` (filtered by repo) into its existing per-repo `/events` SSE so the board
 * stays live — crucial because the brain's ticket tools mutate tickets OUTSIDE the board's HTTP flow,
 * and a client watching the board would otherwise go stale.
 *
 * In-memory, single-process (same model as `LiveTurnStore`): a horizontal scale-out would need a
 * shared bus, out of scope here.
 */
@Injectable()
export class TicketEventBus {
  private readonly subject = new Subject<TicketEvent>();

  publish(event: TicketEvent): void {
    this.subject.next(event);
  }

  get stream$(): Observable<TicketEvent> {
    return this.subject.asObservable();
  }
}
