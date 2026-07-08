"use client";

import { Check, ClipboardCheck, Lock } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { useApprove } from "@/lib/api/job-queries";
import type { JobRef } from "@/lib/api/job-api";
import { APPROVE_ACTION_ID, SHIP_ACTION_ID } from "@/lib/api/types";

/**
 * The async spec-approval surfaces (handoff: "Async Spec / Plan Approval Components") — mirrored for
 * BOTH human gates a job can park at: the plan-approval gate (`awaiting_approval`) and the ship-review
 * gate (`awaiting_ship_review`, the SECOND gate, after the build + master review finish). Neither is
 * approved via a blocking card — the verdict is mirrored onto two always-reachable spots:
 *
 *  - {@link NavigatorApprovalCallout} / {@link NavigatorShipCallout} — a compact callout pinned to the top
 *    of the navigator, above the region the gate is about (SPECS for the plan; OUTPUTS/diff for ship).
 *  - {@link PersistentApprovalBar} / {@link PersistentShipBar} — a slim bar pinned to the bottom of the
 *    detail (right) pane, present no matter what that pane is showing.
 *  - {@link NavigatorApproveButton} / {@link NavigatorShipButton} — the bare button, pinned as the last
 *    item in the navigator's sticky header.
 *
 * All of these POST the SAME verdict the inline approval card does ({@link APPROVE_ACTION_ID} /
 * {@link SHIP_ACTION_ID} + the card's verbatim `value`) via the shared {@link useVerdictAction} hook, and
 * rely on the mutation's message/pipeline invalidation to flip the job onward (`awaiting_approval →
 * running` / `awaiting_ship_review → running`). There is intentionally **no** "Request changes"/"Deny"
 * control on any of these surfaces — that's typed into chat. The parent only renders them while the job
 * sits at the matching status, so a successful verdict naturally unmounts them once the refetch lands; a
 * brief in-place "done" state covers the gap.
 */
const RULED_BY = "U-OPERATOR";

/** Shared verdict action — POSTs a single-button verdict (approve / ship) for the given action id
 *  (idempotent: a second click while pending/succeeded is a no-op). */
function useVerdictAction(jobRef: JobRef, actionId: string, value: string) {
  const approve = useApprove(jobRef);
  const submit = () => {
    if (!value || approve.isPending || approve.isSuccess) return;
    approve.mutate({ actionId, value, ruledBy: RULED_BY });
  };
  return {
    submit,
    pending: approve.isPending,
    approved: approve.isSuccess,
    error: approve.isError,
  };
}

/** The plan-approval verdict — see {@link useVerdictAction}. */
function useApprovePlan(jobRef: JobRef, value: string) {
  return useVerdictAction(jobRef, APPROVE_ACTION_ID, value);
}

/** The ship-review verdict — see {@link useVerdictAction}. */
function useApproveShip(jobRef: JobRef, value: string) {
  return useVerdictAction(jobRef, SHIP_ACTION_ID, value);
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

// ── Component 3 — Navigator Ship Callout ───────────────────────────────────────────────────────────
/**
 * The ship-review counterpart of {@link NavigatorApprovalCallout} — sits above the OUTPUTS region (where
 * the diff/artifacts already live). Title row ("Build reviewed — ready to ship") + a full-width green
 * "Ship it" button.
 */
export function NavigatorShipCallout({
  jobRef,
  value,
}: {
  jobRef: JobRef;
  value: string;
}) {
  const { submit, pending, approved, error } = useApproveShip(jobRef, value);
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
          Build reviewed — ready to ship
        </span>
      </div>
      <ShipButton
        onClick={submit}
        pending={pending}
        approved={approved}
        className="mt-[9px] w-full justify-center text-[11px]"
        style={{ borderRadius: "7px", padding: "7px 0" }}
        iconSize={12}
      />
      {error ? (
        <p className="mt-1.5 text-[10px] text-red">
          Couldn’t ship — try again.
        </p>
      ) : null}
    </div>
  );
}

// ── Navigator header ship button (just the button) ─────────────────────────────────────────────────
/** The bare full-width green "Ship it" button — pinned as the LAST item in the navigator's sticky
 *  header, exactly like {@link NavigatorApproveButton} does for the plan gate. */
export function NavigatorShipButton({
  jobRef,
  value,
}: {
  jobRef: JobRef;
  value: string;
}) {
  const { submit, pending, approved, error } = useApproveShip(jobRef, value);
  return (
    <>
      <ShipButton
        onClick={submit}
        pending={pending}
        approved={approved}
        className="w-full justify-center text-[11px]"
        style={{ borderRadius: "7px", padding: "7px 0" }}
        iconSize={12}
      />
      {error ? (
        <p className="mt-1 text-[10px] text-red">
          Couldn’t ship — try again.
        </p>
      ) : null}
    </>
  );
}

// ── Component 4 — Persistent Ship Bar ───────────────────────────────────────────────────────────────
/**
 * The ship-review counterpart of {@link PersistentApprovalBar} — a `flex:none` footer pinned to the
 * bottom of the detail pane, so the build can be shipped from anywhere in that column.
 */
export function PersistentShipBar({
  jobRef,
  value,
}: {
  jobRef: JobRef;
  value: string;
}) {
  const { submit, pending, approved, error } = useApproveShip(jobRef, value);
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
            ? "Couldn’t ship — try again"
            : approved
              ? "Shipped"
              : "Build reviewed — ready to ship"}
        </div>
        <div className="mt-px text-[10px] text-dim">
          Master review passed. Review the diff, then ship when you’re happy.
        </div>
      </div>
      <ShipButton
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

// ── shared green verdict button ─────────────────────────────────────────────────────────────────────
/** The green verdict button shared by every surface — pending → spinner + verb, success → done label.
 *  Copy is parametrized (`idleLabel`/`pendingLabel`/`doneLabel`) so {@link ApproveButton} and
 *  {@link ShipButton} are thin wrappers over the same look. */
function VerdictButton({
  onClick,
  pending,
  approved,
  idleLabel,
  pendingLabel,
  doneLabel,
  className = "",
  style,
  iconSize,
}: {
  onClick: () => void;
  pending: boolean;
  approved: boolean;
  idleLabel: string;
  pendingLabel: string;
  doneLabel: string;
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
          {pendingLabel}
        </>
      ) : approved ? (
        <>
          <Check size={iconSize} strokeWidth={2.6} />
          {doneLabel}
        </>
      ) : (
        <>
          <Check size={iconSize} strokeWidth={2.6} />
          {idleLabel}
        </>
      )}
    </button>
  );
}

/** The plan-approval verdict button — "Approve plan" / "Approving…" / "Approved". */
function ApproveButton(
  props: Omit<
    React.ComponentProps<typeof VerdictButton>,
    "idleLabel" | "pendingLabel" | "doneLabel"
  >,
) {
  return (
    <VerdictButton
      {...props}
      idleLabel="Approve plan"
      pendingLabel="Approving…"
      doneLabel="Approved"
    />
  );
}

/** The ship-review verdict button — "Ship it" / "Shipping…" / "Shipped". */
function ShipButton(
  props: Omit<
    React.ComponentProps<typeof VerdictButton>,
    "idleLabel" | "pendingLabel" | "doneLabel"
  >,
) {
  return (
    <VerdictButton
      {...props}
      idleLabel="Ship it"
      pendingLabel="Shipping…"
      doneLabel="Shipped"
    />
  );
}
