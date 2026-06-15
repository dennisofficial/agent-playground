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
 *
 * The review-pipeline events narrate the harness-driven PR self-review in the OWNER'S voice: each
 * wakes the owner with a seed so the step reads as the employee's own update (Dennis chose real
 * seeded narration over silent/synthetic). `notifyThread` carries the room the work was opened in.
 *  - `pr-opened`        → the integration barrier opened the shared-branch DRAFT PR and is running
 *                         the final review.
 *  - `self-review-ready`→ the integration review finished; its full findings are parked as a ticket
 *                         note and the DECISION OWNER is woken to decide — ship it (mark_pr_ready) or
 *                         feed the notes into their open execute session and fix. The harness no longer
 *                         judges pass/fail here; the owner does. Carries the note id + mechanical
 *                         handles (the PR url, the owner's execute session + worktree).
 *  - `self-review-failed`→ a per-owner or integration review couldn't be auto-cleared (fix loop
 *                         exhausted, a publish conflict, or a GitHub failure) and needs the owner.
 *  - `pr-ready`         → self-review cleared, the PR is flipped to ready, the ticket is in_review.
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
  | { kind: 'ticket-approved'; team: string; taskId: number }
  | {
      kind: 'pr-opened';
      team: string;
      taskId: number;
      employee: string;
      prUrl: string;
      notifyThread?: string;
    }
  | {
      kind: 'self-review-ready';
      team: string;
      taskId: number;
      /** The single decision owner woken to ship-or-fix (the board assignee, fallback the anchor). */
      employee: string;
      prUrl: string;
      /** The ticket note (#id) holding the full review findings — fed into a fix turn by id. */
      noteId: number;
      /** Mechanical handles so the owner can act without hunting: their execute worktree + session. */
      worktreeId: string;
      sessionId?: string;
      notifyThread?: string;
    }
  | {
      kind: 'self-review-failed';
      team: string;
      taskId: number;
      employee: string;
      /** What blocked auto-clearing — surfaced to the owner so they know what to fix. */
      reason: string;
      notifyThread?: string;
    }
  | {
      kind: 'pr-ready';
      team: string;
      taskId: number;
      employee: string;
      prUrl: string;
      notifyThread?: string;
    };

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
