"use client";

import { Check, ClipboardCheck, Lock } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { useApprove } from "@/lib/api/job-queries";
import type { JobRef } from "@/lib/api/job-api";
import { APPROVE_ACTION_ID } from "@/lib/api/types";

/**
 * The two async spec-approval surfaces (handoff: "Async Spec / Plan Approval Components"). A thread's plan
 * is approved WHENEVER the operator is ready — not via a blocking card — so the approve action is mirrored
 * onto two always-reachable spots:
 *
 *  - {@link NavigatorApprovalCallout} — a compact "Plan ready for review" card pinned to the top of the
 *    navigator, above the SPECS list (where the spec files + proposed pipeline already live).
 *  - {@link PersistentApprovalBar} — a slim bar pinned to the bottom of the detail (right) pane, present no
 *    matter what that pane is showing.
 *
 * Both POST the SAME verdict the inline approval card does (`APPROVE_ACTION_ID` + the card's verbatim
 * `value`) and rely on the mutation's message/pipeline invalidation to flip `awaiting_approval → running`.
 * There is intentionally **no** "Request changes" control here — change requests are typed into chat. The
 * parent only renders these while the thread is `awaiting_approval`, so a successful approval naturally
 * unmounts them once the refetch lands; a brief in-place "Approved" state covers the gap.
 */
const RULED_BY = "U-OPERATOR";

/** Shared approve action — POSTs the approve verdict for the thread's whole spec set (idempotent). */
function useApprovePlan(jobRef: JobRef, value: string) {
  const approve = useApprove(jobRef);
  const submit = () => {
    if (!value || approve.isPending || approve.isSuccess) return;
    approve.mutate({ actionId: APPROVE_ACTION_ID, value, ruledBy: RULED_BY });
  };
  return {
    submit,
    pending: approve.isPending,
    approved: approve.isSuccess,
    error: approve.isError,
  };
}

// ── Component 1 — Navigator Approval Callout ───────────────────────────────────────────────────────
/**
 * The navigator callout — sits above the SPECS header. Title row ("Plan ready for review") + a full-width
 * green Approve button. No spec/step counts (removed deliberately); the spec list renders below as usual.
 */
export function NavigatorApprovalCallout({
  jobRef,
  value,
}: {
  jobRef: JobRef;
  value: string;
}) {
  const { submit, pending, approved, error } = useApprovePlan(jobRef, value);
  return (
    <div
      className="mx-1.5 mb-3 rounded-lg border"
      style={{
        borderColor: "var(--accent-line)",
        background: "var(--accent-soft)",
        padding: "10px 11px",
      }}
    >
      <div className="flex items-center gap-1.5">
        <ClipboardCheck
          size={11}
          strokeWidth={2}
          style={{ color: "var(--accent)" }}
          className="shrink-0"
        />
        <span
          className="text-[11px] font-bold"
          style={{ color: "var(--accent)" }}
        >
          Plan ready for review
        </span>
      </div>
      <ApproveButton
        onClick={submit}
        pending={pending}
        approved={approved}
        className="mt-[9px] w-full justify-center text-[11px]"
        style={{ borderRadius: "7px", padding: "7px 0" }}
        iconSize={12}
      />
      {error ? (
        <p className="mt-1.5 text-[10px] text-red">
          Couldn’t approve — try again.
        </p>
      ) : null}
    </div>
  );
}

// ── Navigator header approve button (just the button) ──────────────────────────────────────────────
/** The bare full-width green Approve button — pinned as the LAST item in the navigator's sticky header
 *  (no card/title). Same idempotent verdict as the other surfaces. */
export function NavigatorApproveButton({
  jobRef,
  value,
}: {
  jobRef: JobRef;
  value: string;
}) {
  const { submit, pending, approved, error } = useApprovePlan(jobRef, value);
  return (
    <>
      <ApproveButton
        onClick={submit}
        pending={pending}
        approved={approved}
        className="w-full justify-center text-[11px]"
        style={{ borderRadius: "7px", padding: "7px 0" }}
        iconSize={12}
      />
      {error ? (
        <p className="mt-1 text-[10px] text-red">
          Couldn’t approve — try again.
        </p>
      ) : null}
    </>
  );
}

// ── Component 2 — Persistent Approval Bar ──────────────────────────────────────────────────────────
/**
 * The persistent bar — `flex:none` footer pinned to the bottom of the detail pane, so the plan can be
 * approved from anywhere in that column. Leading lock tile · text block (dynamic spec/step counts) ·
 * trailing green Approve button.
 */
export function PersistentApprovalBar({
  jobRef,
  value,
  specCount,
  stepCount,
}: {
  jobRef: JobRef;
  value: string;
  specCount: number;
  stepCount: number;
}) {
  const { submit, pending, approved, error } = useApprovePlan(jobRef, value);
  return (
    <div
      className="flex shrink-0 items-center gap-[11px] border-t"
      style={{
        borderColor: "var(--accent-line)",
        background: "var(--accent-soft)",
        padding: "10px 16px",
      }}
    >
      <div
        className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-lg border"
        style={{
          background: "var(--panel)",
          borderColor: "var(--accent-line)",
        }}
      >
        <Lock size={14} strokeWidth={2} style={{ color: "var(--accent)" }} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[11.5px] font-bold text-text">
          {error
            ? "Couldn’t approve — try again"
            : approved
              ? "Plan approved"
              : "Plan awaiting your approval"}
        </div>
        <div className="mt-px text-[10px] text-dim">
          {specCount} spec{specCount === 1 ? "" : "s"} · {stepCount} step
          {stepCount === 1 ? "" : "s"} · approve from anywhere in this pane
        </div>
      </div>
      <ApproveButton
        onClick={submit}
        pending={pending}
        approved={approved}
        className="text-[11.5px]"
        style={{
          borderRadius: "8px",
          padding: "8px 15px",
          border: "1px solid var(--green)",
        }}
        iconSize={13}
      />
    </div>
  );
}

// ── shared green Approve button ────────────────────────────────────────────────────────────────────
/** The green "Approve plan" button shared by both surfaces — pending → spinner, success → "Approved". */
function ApproveButton({
  onClick,
  pending,
  approved,
  className = "",
  style,
  iconSize,
}: {
  onClick: () => void;
  pending: boolean;
  approved: boolean;
  className?: string;
  style?: React.CSSProperties;
  iconSize: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending || approved}
      className={`inline-flex items-center gap-1.5 font-bold text-white transition hover:brightness-95 disabled:cursor-default disabled:opacity-90 ${className}`}
      style={{
        background: "var(--green)",
        boxShadow: "0 2px 8px var(--green-soft)",
        ...style,
      }}
    >
      {pending ? (
        <>
          <Spinner className="h-3 w-3" />
          Approving…
        </>
      ) : approved ? (
        <>
          <Check size={iconSize} strokeWidth={2.6} />
          Approved
        </>
      ) : (
        <>
          <Check size={iconSize} strokeWidth={2.6} />
          Approve plan
        </>
      )}
    </button>
  );
}
