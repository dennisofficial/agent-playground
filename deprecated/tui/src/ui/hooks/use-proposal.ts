import { useCallback, useEffect, useMemo, useState } from "react";
import type { AttachmentPart } from "../../domain/attachments.js";
import {
  DECLINED_NOTICE,
  opensAsReview,
  opensProposal,
  proposalView,
  type ProposalView,
} from "../../domain/transition-review.js";
import type { TransitionRow } from "../../store/transition.repository.js";
import { useServices } from "../services.js";
import { useInput } from "./use-input.js";

/** Everything the conversation page needs to draw and answer a proposal. */
export type ProposalControls = {
  /** Null when nothing is waiting on a keypress in this job. */
  view: ProposalView | null;
  parts: readonly AttachmentPart[];
  /** Whether the overlay is up — and therefore whether it owns the keyboard. */
  open: boolean;
  /**
   * A proposal is waiting but the overlay is not showing it — pushed away with `esc`, or held back
   * because there is a draft in the composer. The only state in which `ctrl+y` means anything, and
   * the reason the key needs a line of its own rather than a row in the keymap panel.
   */
  waiting: boolean;
  expanded: boolean;
  busy: boolean;
  error: string | null;
  /** Said once after `n`, because declining deliberately does nothing else. */
  notice: string | null;
};

/**
 * The job's pending phase advance: read it, show it, answer it.
 *
 * **Job-scoped, not thread-scoped.** The proposer is one thread of the job and Dennis may be
 * standing in another, so scoping this to the open thread would hide the ask behind a navigation —
 * and "confirming is a single keypress from the job" is the loop's whole cost model.
 *
 * Re-read on the transcript's revision rather than on a clock: a proposal is raised by a tool call
 * inside a turn, so the message count moving IS the signal that one may exist. The same signal the
 * checklist and the thread list already ride.
 */
export function useProposal(args: {
  jobId: string;
  /** Where the successor's first thread will run — `confirmTransition` seeds a turn in it. */
  cwd: string;
  /** Anything that moves when an agent might have raised one. The message count, in practice. */
  revision: number;
  /** A half-typed steer. A proposal never takes the keyboard out of one — see `opensProposal`. */
  draftLength: number;
}): ProposalControls {
  const { threadSeamService, transitionReviewService } = useServices();
  const [pending, setPending] = useState<TransitionRow | null>(null);
  const [attachments, setAttachments] = useState<{
    id: string;
    view: ProposalView;
    parts: readonly AttachmentPart[];
    review: boolean;
  } | null>(null);
  // Which proposal was asked for, pushed away, or answered — ids rather than booleans, so a second
  // proposal raised after the first was deferred opens on its own account.
  const [requestedId, setRequestedId] = useState<string | null>(null);
  const [deferredId, setDeferredId] = useState<string | null>(null);
  const [expandedOverride, setExpandedOverride] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);

  const reload = useCallback(() => setReloads((count) => count + 1), []);

  useEffect(() => {
    let live = true;
    void threadSeamService
      .pendingTransitions(args.jobId)
      .then((rows) => {
        // Oldest first, and only the head: several are possible in principle and the queue is
        // answered in the order it formed. One decision at a time is also what keeps `y` unambiguous.
        if (live) setPending(rows[0] ?? null);
      })
      // A read that failed is a proposal that did not appear. The next turn boundary asks again, and
      // a transient SQLite busy must never put an error where the conversation was.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [threadSeamService, args.jobId, args.revision, reloads]);

  const pendingId = pending?.id ?? null;

  // The bodies are read only when there is something to show, and only once per proposal: this
  // inlines every attached file in full, which is a plan's worth of markdown on a plan boundary.
  useEffect(() => {
    if (pendingId === null) {
      setAttachments(null);
      return;
    }
    let live = true;
    void transitionReviewService
      .review(pendingId)
      .then((review) => {
        if (!live || !review) return;
        setAttachments({
          id: pendingId,
          view: proposalView({
            transition: review.transition,
            from: review.from,
            attached: review.attached,
          }),
          parts: review.parts,
          review: opensAsReview(review.attached),
        });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [transitionReviewService, pendingId]);

  // A new proposal is a new decision: whatever was toggled about the last one says nothing about it.
  useEffect(() => {
    setExpandedOverride(null);
    setError(null);
  }, [pendingId]);

  // The nudge after `n` has done its job the moment he starts typing why — the same rule that
  // disarms the clear warning, and for the same reason.
  const typing = args.draftLength > 0;
  useEffect(() => {
    if (typing) setNotice(null);
  }, [typing]);

  const open = opensProposal({
    pendingId,
    requestedId,
    deferredId,
    draftLength: args.draftLength,
  });

  // A proposal carrying specs opens AS a review — the plan on screen is what makes `y` approval
  // rather than a shrug (design 02 §3). Anything else opens as the ask alone.
  const expanded = expandedOverride ?? attachments?.review ?? false;

  const handleConfirm = useCallback(() => {
    if (pendingId === null || busy) return;
    setBusy(true);
    setError(null);
    void threadSeamService
      .confirmTransition({ transitionId: pendingId, cwd: args.cwd })
      // Nothing navigates here. Confirming moves the job's cursor and seeds the new thread, which
      // fires a turn — and `useCursorFollow` rides exactly that signal, carrying Dennis to the new
      // phase's first thread. A second mechanism would race it.
      .then(() => setPending(null))
      // The one real failure: another terminal answered first. `requirePending` throws rather than
      // appending a second phase for one ask, and the human is told which way it went.
      .catch((e: Error) => setError(e.message))
      .finally(() => {
        setBusy(false);
        reload();
      });
  }, [threadSeamService, pendingId, args.cwd, busy, reload]);

  const handleDecline = useCallback(() => {
    if (pendingId === null || busy) return;
    setBusy(true);
    setError(null);
    void threadSeamService
      .declineTransition({ transitionId: pendingId })
      // No reason is passed, and that is the design: the proposing thread is still open and its
      // composer is right there, so saying why is a conversation rather than a form field.
      .then(() => {
        setPending(null);
        setNotice(DECLINED_NOTICE);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => {
        setBusy(false);
        reload();
      });
  }, [threadSeamService, pendingId, busy, reload]);

  useInput((input, key) => {
    if (pendingId === null) return;

    // The way back to a proposal that was pushed away, and the only key that acts while the overlay
    // is shut — everything else belongs to the composer, which is still live behind it.
    if (key.ctrl && input === "y") {
      setRequestedId(pendingId);
      setDeferredId(null);
      return;
    }
    if (!open || busy) return;

    if (input === "y") return handleConfirm();
    if (input === "n") return handleDecline();
    if (input === "x") return setExpandedOverride(!expanded);
    // Later. The row stays pending and the lists keep saying `confirm`, which is the point of the
    // ask being a row: it survives the escape, the page, the process and the week.
    if (key.escape) {
      setRequestedId(null);
      setDeferredId(pendingId);
    }
  });

  const view = useMemo(
    () => (attachments?.id === pendingId ? attachments.view : null),
    [attachments, pendingId],
  );

  return {
    view,
    parts: attachments?.id === pendingId ? attachments.parts : [],
    // Never open on a proposal whose files have not arrived: the overlay would take the keyboard to
    // show a frame with no reason in it, which is the one moment a stray `y` is unanswerable.
    open: open && view !== null,
    waiting: pendingId !== null && !(open && view !== null),
    expanded,
    busy,
    error,
    notice,
  };
}
