"use client";

import { useMemo, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ClipboardCheck,
  Globe,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Markdown } from "./markdown";
import { makeResolveFileLink } from "./repo-file-links";
import { PREVIEW_REQUEST_TEXT } from "./preview-request";
import { useApprove, useRepoTree, useSay } from "@/lib/api/job-queries";
import type { JobRef } from "@/lib/api/job-api";
import { isSubmitCombo } from "@/lib/keyboard";
import {
  AMEND_APPROVE_ACTION_ID,
  AMEND_DISMISS_ACTION_ID,
  APPROVE_ACTION_ID,
  DENY_ACTION_ID,
  RETRACT_SHIP_ACTION_ID,
  type ApprovalActionId,
  type WebApprovalCard,
  type WebCardAction,
  type WebVerdictCard,
} from "@/lib/api/types";

const RULED_BY = "U-OPERATOR";

const NOTE_PROMPT: Partial<Record<ApprovalActionId, string>> = {
  [DENY_ACTION_ID]: "Why deny this? (optional)",
};

/**
 * The inline plan / approval card — the gate. Approve / Deny POST the verdict to
 * `…/threads/:jobId/approve` with the card action's verbatim `value`; the backend re-emits the card
 * as a verdict over SSE, which the refetch repaints in place. "Open full plan" switches the work column
 * to the plan doc (in-page, matching the comp — no separate route). To request changes, the operator
 * just messages the brain — there is no request-changes verdict button.
 */
export function ApprovalCardView({
  card,
  jobRef,
  onOpenPlan,
  onSelectNode,
}: {
  card: WebApprovalCard;
  jobRef: JobRef;
  onOpenPlan?: () => void;
  onSelectNode?: (node: string) => void;
}) {
  // The ship-review gate and the brain's "Amend build?" proposal reuse this same `approval_card` payload
  // (discriminated by `kind: 'ship' | 'amend'`) but are a much smaller card — a title/summary + gate
  // buttons, rendered generically off `card.actions` (never a hardcoded action id, so the card doesn't
  // drift from whatever the backend sends).
  if (card.kind === "ship" || card.kind === "amend") {
    return <ShipCardView card={card} jobRef={jobRef} />;
  }
  return (
    <PlanApprovalCardView
      card={card}
      jobRef={jobRef}
      onOpenPlan={onOpenPlan}
      onSelectNode={onSelectNode}
    />
  );
}

function PlanApprovalCardView({
  card,
  jobRef,
  onOpenPlan,
  onSelectNode,
}: {
  card: WebApprovalCard;
  jobRef: JobRef;
  onOpenPlan?: () => void;
  onSelectNode?: (node: string) => void;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const repoTree = useRepoTree(jobRef);
  const fileSet = useMemo(
    () => new Set(repoTree.data?.files ?? []),
    [repoTree.data],
  );

  const value =
    card.actions.find((a) => a.actionId === APPROVE_ACTION_ID)?.value ??
    card.actions[0]?.value ??
    "";
  const confirmedCount = card.decisions.filter(
    (d) => d.confirmedByOperator,
  ).length;
  const authoredCount = card.decisions.length - confirmedCount;

  return (
    <div className="anim-pop self-stretch overflow-hidden rounded-lg border border-border bg-surface">
      <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
        <ClipboardCheck size={15} className="text-accent" />
        <span className="text-[13px] font-semibold text-text">
          Proposed plan
        </span>
        <div className="flex-1" />
        <span
          className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-[9.5px]"
          style={{
            color: "var(--purple)",
            borderColor: "color-mix(in srgb, var(--purple) 38%, transparent)",
          }}
        >
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ background: "var(--purple)" }}
          />
          awaiting approval
        </span>
      </div>

      <div className="px-4 py-3">
        <h3 className="text-[14px] font-semibold text-text">{card.title}</h3>
        {card.summary ? (
          <div className="mt-1.5">
            <Markdown
              resolveFileLink={
                onSelectNode
                  ? makeResolveFileLink(
                      fileSet,
                      pathname,
                      searchParams,
                      onSelectNode,
                    )
                  : undefined
              }
            >
              {card.summary}
            </Markdown>
          </div>
        ) : null}
      </div>

      <button
        type="button"
        onClick={onOpenPlan}
        className="flex w-full items-center gap-2.5 border-t border-border bg-surface-2 px-4 py-3 text-left hover:brightness-[0.99]"
      >
        <span className="font-mono text-[10.5px] text-dim">
          {confirmedCount} confirmed · {authoredCount} Atlas-authored ·{" "}
          {card.threads.length} {card.kind === "direct" ? "change" : "thread"}
          {card.threads.length === 1 ? "" : "s"}
        </span>
        <div className="flex-1" />
        <span className="inline-flex items-center gap-1.5 text-[11.5px] font-medium text-accent">
          Open full plan <ArrowRight size={13} />
        </span>
      </button>

      {authoredCount > 0 ? (
        <div
          className="flex items-start gap-2 border-t border-border px-4 py-2.5 text-[11.5px] leading-relaxed"
          style={{
            color: "var(--amber, #b45309)",
            background:
              "color-mix(in srgb, var(--amber, #b45309) 8%, transparent)",
          }}
        >
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span>
            {authoredCount} decision{authoredCount === 1 ? "" : "s"}{" "}
            {authoredCount === 1 ? "was" : "were"} authored by Atlas, not
            confirmed by you — review {authoredCount === 1 ? "it" : "them"}{" "}
            before approving.
          </span>
        </div>
      ) : null}

      <div className="border-t border-border bg-surface-2 px-4 py-3">
        <VerdictButtons
          jobRef={jobRef}
          value={value}
          approveLabel={
            card.kind === "direct" ? "Approve Direct Build" : "Approve"
          }
        />
      </div>
    </div>
  );
}

/**
 * The inline ship-review card — the SECOND human gate (after the plan-approval card above), posted once
 * the build + master review finish. Just a title/summary and the backend-provided ship-gate actions.
 */
function ShipCardView({ card, jobRef }: { card: WebApprovalCard; jobRef: JobRef }) {
  return (
    <div className="anim-pop self-stretch overflow-hidden rounded-lg border border-border bg-surface">
      <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
        <ClipboardCheck size={15} className="text-accent" />
        <span className="text-[13px] font-semibold text-text">
          {card.title}
        </span>
        <div className="flex-1" />
        <span
          className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-[9.5px]"
          style={{
            color: "var(--purple)",
            borderColor: "color-mix(in srgb, var(--purple) 38%, transparent)",
          }}
        >
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ background: "var(--purple)" }}
          />
          {card.kind === "amend" ? "awaiting your call" : "awaiting ship"}
        </span>
      </div>

      {card.summary ? (
        <div className="px-4 py-3">
          <Markdown>{card.summary}</Markdown>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2 border-t border-border bg-surface-2 px-4 py-3">
        {card.actions.map((action) => (
          <ShipActionButton key={action.actionId} jobRef={jobRef} action={action} />
        ))}
        {card.kind === "ship" ? <ShipCardPreviewButton jobRef={jobRef} /> : null}
      </div>
    </div>
  );
}

/** "Spin up preview" — asks the build brain (via the `say` path) to stand up a demo-ready live preview of
 *  the just-built change. Status/handover come back through chat; the live URL auto-surfaces in PORTS. Only
 *  shown at the ship gate (`kind: 'ship'`), never on an amend card. */
function ShipCardPreviewButton({ jobRef }: { jobRef: JobRef }) {
  const say = useSay(jobRef);
  return (
    <Button
      size="sm"
      variant="ghost"
      loading={say.isPending}
      loadingText="Requesting…"
      icon={<Globe size={13} />}
      onClick={() => {
        if (!say.isPending) say.mutate(PREVIEW_REQUEST_TEXT);
      }}
      className="text-accent"
      style={{ borderColor: "var(--accent-line)" }}
    >
      Spin up preview
    </Button>
  );
}

/** One ship-card action button — POSTs the verdict endpoint with the card action's OWN `actionId`/`value`
 *  (never a hardcoded constant), so the card renders generically off whatever `actions` the backend sends. */
function ShipActionButton({
  jobRef,
  action,
}: {
  jobRef: JobRef;
  action: WebCardAction;
}) {
  const approve = useApprove(jobRef);
  const variant =
    action.style === "danger"
      ? "danger"
      : action.style === "default"
        ? "ghost"
        : "primary";
  const loadingText =
    action.actionId === AMEND_APPROVE_ACTION_ID
      ? "Amending…"
      : action.actionId === AMEND_DISMISS_ACTION_ID
        ? "Dismissing…"
        : action.actionId === RETRACT_SHIP_ACTION_ID
          ? "Retracting…"
          : "Shipping…";
  return (
    <div className="flex flex-col gap-2">
      <Button
        size="sm"
        variant={variant}
        loading={approve.isPending}
        loadingText={loadingText}
        onClick={() =>
          approve.mutate({
            actionId: action.actionId,
            value: action.value,
            ruledBy: RULED_BY,
          })
        }
      >
        {action.label}
      </Button>
      {approve.isError ? (
        <p className="text-[11.5px] text-red">
          Could not submit. Try again.
        </p>
      ) : null}
    </div>
  );
}

/** The plan-verdict buttons (Approve / Deny). Deny reveals an optional `note` before submitting. */
export function VerdictButtons({
  jobRef,
  value,
  approveLabel = "Approve",
  size = "sm",
}: {
  jobRef: JobRef;
  value: string;
  approveLabel?: string;
  size?: "sm" | "md";
}) {
  const approve = useApprove(jobRef);
  const pending = approve.isPending;
  const [drafting, setDrafting] = useState<ApprovalActionId | null>(null);
  const [note, setNote] = useState("");

  function send(actionId: ApprovalActionId, reason?: string) {
    if (!value) return;
    const trimmed = reason?.trim();
    approve.mutate({
      actionId,
      value,
      ruledBy: RULED_BY,
      ...(trimmed ? { note: trimmed } : {}),
    });
  }

  function onVerdict(actionId: ApprovalActionId) {
    if (actionId === APPROVE_ACTION_ID) {
      send(actionId);
      return;
    }
    setNote("");
    setDrafting(actionId);
  }

  if (drafting) {
    return (
      <div className="flex flex-col gap-2">
        <textarea
          autoFocus
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            // ⌘/Ctrl+Enter submits the verdict; plain Enter still inserts a newline.
            if (!isSubmitCombo(e)) return;
            e.preventDefault();
            if (pending) return;
            send(drafting, note);
            setDrafting(null);
          }}
          placeholder={NOTE_PROMPT[drafting] ?? "Add a note (optional)"}
          rows={2}
          className="w-full resize-y rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-[12.5px] text-text outline-none placeholder:text-faint focus:border-accent"
        />
        <div className="flex flex-wrap gap-2">
          <Button
            size={size}
            variant="danger"
            loading={pending}
            loadingText="Submitting…"
            onClick={() => {
              send(drafting, note);
              setDrafting(null);
            }}
          >
            Deny
          </Button>
          <Button
            size={size}
            variant="ghost"
            disabled={pending}
            onClick={() => setDrafting(null)}
          >
            Cancel
          </Button>
        </div>
        {approve.isError ? (
          <p className="text-[11.5px] text-red">
            Could not submit the verdict. Try again.
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <Button
          size={size}
          loading={pending}
          loadingText="Submitting…"
          onClick={() => onVerdict(APPROVE_ACTION_ID)}
        >
          {approveLabel}
        </Button>
        <Button
          size={size}
          variant="danger"
          disabled={pending}
          onClick={() => onVerdict(DENY_ACTION_ID)}
        >
          Deny
        </Button>
      </div>
      {approve.isError ? (
        <p className="text-[11.5px] text-red">
          Could not submit the verdict. Try again.
        </p>
      ) : null}
    </div>
  );
}

/** Green confirmation bar that replaces the approval card after a ruling (a verdict_card over SSE). */
export function VerdictCardView({ card }: { card: WebVerdictCard }) {
  const approved = card.verdict === "approve";
  const color = approved ? "var(--green)" : "var(--red)";
  return (
    <div
      className="anim-pop flex items-center gap-2.5 self-stretch rounded-lg border px-4 py-3"
      style={{
        background: `color-mix(in srgb, ${color} 8%, transparent)`,
        borderColor: `color-mix(in srgb, ${color} 35%, transparent)`,
      }}
    >
      <CheckCircle2 size={16} style={{ color }} />
      <div>
        <p className="text-[12.5px] font-semibold" style={{ color }}>
          {card.title}
        </p>
        <p className="text-[12px] text-dim">{card.verdictLine}</p>
      </div>
    </div>
  );
}
