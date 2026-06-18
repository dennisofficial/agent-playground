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
 *                         handles (the PR url, the owner's execute session + workspace).
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
  // A proposed plan got a NON-approve verdict (the section-driver reacts: re-plan vs release). Fired
  // from BoardStore.transition on the unique awaiting_approval→planning / →open verdict transitions.
  | { kind: 'ticket-changes-requested'; team: string; taskId: number }
  | { kind: 'ticket-denied'; team: string; taskId: number }
  // A section-driver run reached a DESIGN section — paused for the human to attach the design
  // artifact (attach_design) or skip it (skip_design). Narrated so Atlas prompts Dennis.
  | {
      kind: 'design-gate';
      team: string;
      taskId: number;
      section: string;
      notifyThread?: string;
    }
  // A section plan/build session ended with QUESTIONS instead of a finished plan/build — relayed so
  // Atlas answers (answer_section) or brings the product calls to Dennis. NOT a plan gate; no card.
  | {
      kind: 'section-questions';
      team: string;
      taskId: number;
      /** The section that asked (undefined for a bugfix run). */
      section?: string;
      /** The full questions text the session reported. */
      questions: string;
      notifyThread?: string;
    }
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
      /** Mechanical handles so the owner can act without hunting: their execute workspace + session. */
      workspaceId: string;
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
    }
  // A pipeline review stage finished with a call that is ATLAS'S to make (a cross-section defect at the
  // full-implementation review, or a per-section review blocker) — the run is PAUSED and Atlas is woken
  // with the findings + the menu of actions he owns. The structured "wake-up channel" / "walk Atlas's
  // hands": a JIT decision prompt delivered as a gate-bypassed seed (boardEventRelayPrompt renders it,
  // maybeRelayBoardEvent routes it), keeping the system prompt lean. Reusable for any future judgment
  // moment a stage needs to hand to Atlas without blocking on him.
  | {
      kind: 'stage-decision';
      team: string;
      taskId: number;
      /** The stage that finished and needs a call, e.g. 'full implementation review'. */
      stage: string;
      /** The review's findings — what Atlas is deciding about. */
      findings: string;
      /** The actions Atlas may take, default-first (tool call + one-line description each). */
      allowedActions: ReadonlyArray<{ action: string; description: string }>;
      /** The section the defect was scoped to, when it's a per-section call (undefined = ticket-level). */
      section?: string;
      notifyThread?: string;
    }
  // A build/execute stage noticed something OUT OF SCOPE while working and emitted it (a ```findings```
  // block in its report). ADVISORY, not a gate: the run is NOT paused and there's nothing for Atlas to
  // unblock — it just reaches him (the single voice, the only one who can post to Dennis) so he can
  // triage it with the tools he already has: suggest_task it (a chip), enqueue_finding it (silent park),
  // or skip it. Distinct from `stage-decision`, which PAUSES the run on a call Atlas must make. Without
  // this the finding dies in the stage's transcript (the report is parsed only for handoff/verdict).
  | {
      kind: 'stage-findings';
      team: string;
      taskId: number;
      /** The stage that flagged them, e.g. 'phase_backend' (label only). */
      stage: string;
      /** The section the stage was building (undefined for a bugfix run). */
      section?: string;
      /** The out-of-scope discoveries, verbatim from the stage's `findings` block. */
      findings: string;
      notifyThread?: string;
    }
  // A pipeline run hit a TERMINAL failure and was torn down (`failRun`): a session died, a propose/ship
  // failed, a workspace/section went missing, etc. The run is flipped to 'failed' and its ticket reset to
  // 'open' (back on the backlog), but without this event the death is SILENT — logged + DB-only, nothing
  // wakes the orchestrator. So a crashed pipeline went unnoticed until Dennis asked. Narrated in Atlas's
  // voice so he tells Dennis it died + why and decides recovery (re-dispatch / loop Dennis in). This is
  // the failure-side symmetry of the forward events above; `self-review-failed` covers the review stage,
  // this covers every OTHER terminal failure the section-driver can hit.
  | {
      kind: 'run-failed';
      team: string;
      taskId: number;
      /** Why the run died — the `failRun` reason (dev-facing, but the concrete handle for recovery). */
      reason: string;
      /** The section active when it died, when known (undefined = ticket-level / bugfix run). */
      section?: string;
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
