import { Injectable } from '@nestjs/common';
import { Subject } from 'rxjs';

/**
 * Board lifecycle events — the seam that turns the planning→approval→execution pipeline from a
 * prose-driven handoff (an owner remembering to announce, the lead's gate happening to fire) into
 * mechanical state-transition wake-ups. The board stores emit; the conductor subscribes and wakes
 * the right bot via `injectSeed` (the gate-bypassed seed primitive — same delivery as a session
 * relay). Kept as a tiny leaf provider with NO dependencies so both the memory stores (emitters)
 * and the conductor (subscriber) can depend on it without a module cycle.
 *
 * Only the unambiguous transitions are emitted:
 *  - `plan-attached`  → a board-linked planning session attached/re-attached its plan (the lead
 *                       reviews it). Re-attach resets lead_status to 'pending', so a revision
 *                       re-fires and earns a fresh review.
 *  - `ticket-approved`→ a ticket flipped to 'approved' (the owner opens a fresh execute session).
 *                       Fired from BOTH the CAS path (the Slack approval card → BoardStore.transition)
 *                       and the manual path (a lead's update_board_task → BoardStore.update), so it
 *                       fires no matter how the verdict arrives.
 */
export type BoardEvent =
  | {
      kind: 'plan-attached';
      team: string;
      taskId: number;
      /** The teammate whose plan attached — used to skip self-review when they ARE the lead. */
      employee: string;
      /** The planning session the plan came from — resolves the room to wake the lead in. */
      sessionId?: string;
    }
  | { kind: 'ticket-approved'; team: string; taskId: number };

@Injectable()
export class BoardEventsBus {
  private readonly subject = new Subject<BoardEvent>();

  emit(event: BoardEvent): void {
    this.subject.next(event);
  }

  /** Subscribe to board events. Returns an unsubscribe function (mirrors SessionRegistry.onUpdate). */
  onEvent(cb: (event: BoardEvent) => void): () => void {
    const sub = this.subject.subscribe(cb);
    return () => sub.unsubscribe();
  }
}
