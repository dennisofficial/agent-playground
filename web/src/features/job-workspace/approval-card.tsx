'use client';

import { useState } from 'react';
import { AlertTriangle, ArrowRight, CheckCircle2, ClipboardCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useApprove } from '@/lib/api/job-queries';
import type { JobRef } from '@/lib/api/job-api';
import {
  APPROVE_ACTION_ID,
  DENY_ACTION_ID,
  type ApprovalActionId,
  type WebApprovalCard,
  type WebVerdictCard,
} from '@/lib/api/types';

const RULED_BY = 'U-OPERATOR';

const NOTE_PROMPT: Partial<Record<ApprovalActionId, string>> = {
  [DENY_ACTION_ID]: 'Why deny this? (optional)',
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
}: {
  card: WebApprovalCard;
  jobRef: JobRef;
  onOpenPlan?: () => void;
}) {
  const value = card.actions.find((a) => a.actionId === APPROVE_ACTION_ID)?.value ?? card.actions[0]?.value ?? '';
  const confirmedCount = card.decisions.filter((d) => d.confirmedByOperator).length;
  const authoredCount = card.decisions.length - confirmedCount;

  return (
    <div className="anim-pop self-stretch overflow-hidden rounded-lg border border-border bg-surface">
      <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
        <ClipboardCheck size={15} className="text-accent" />
        <span className="text-[13px] font-semibold text-text">Proposed plan</span>
        <div className="flex-1" />
        <span
          className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-[9.5px]"
          style={{ color: 'var(--purple)', borderColor: 'color-mix(in srgb, var(--purple) 38%, transparent)' }}
        >
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: 'var(--purple)' }} />
          awaiting approval
        </span>
      </div>

      <div className="px-4 py-3">
        <h3 className="text-[14px] font-semibold text-text">{card.title}</h3>
        {card.summary ? (
          <p className="mt-1.5 whitespace-pre-wrap text-[12.5px] leading-relaxed text-dim">{card.summary}</p>
        ) : null}
      </div>

      <button
        type="button"
        onClick={onOpenPlan}
        className="flex w-full items-center gap-2.5 border-t border-border bg-surface-2 px-4 py-3 text-left hover:brightness-[0.99]"
      >
        <span className="font-mono text-[10.5px] text-dim">
          {confirmedCount} confirmed · {authoredCount} Atlas-authored · {card.threads.length}{' '}
          {card.kind === 'direct' ? 'change' : 'thread'}
          {card.threads.length === 1 ? '' : 's'}
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
            color: 'var(--amber, #b45309)',
            background: 'color-mix(in srgb, var(--amber, #b45309) 8%, transparent)',
          }}
        >
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span>
            {authoredCount} decision{authoredCount === 1 ? '' : 's'} {authoredCount === 1 ? 'was' : 'were'} authored by
            Atlas, not confirmed by you — review {authoredCount === 1 ? 'it' : 'them'} before approving.
          </span>
        </div>
      ) : null}

      <div className="border-t border-border bg-surface-2 px-4 py-3">
        <VerdictButtons jobRef={jobRef} value={value} />
      </div>
    </div>
  );
}

/** The plan-verdict buttons (Approve / Deny). Deny reveals an optional `note` before submitting. */
export function VerdictButtons({
  jobRef,
  value,
  approveLabel = 'Approve',
  size = 'sm',
}: {
  jobRef: JobRef;
  value: string;
  approveLabel?: string;
  size?: 'sm' | 'md';
}) {
  const approve = useApprove(jobRef);
  const pending = approve.isPending;
  const [drafting, setDrafting] = useState<ApprovalActionId | null>(null);
  const [note, setNote] = useState('');

  function send(actionId: ApprovalActionId, reason?: string) {
    if (!value) return;
    const trimmed = reason?.trim();
    approve.mutate({ actionId, value, ruledBy: RULED_BY, ...(trimmed ? { note: trimmed } : {}) });
  }

  function onVerdict(actionId: ApprovalActionId) {
    if (actionId === APPROVE_ACTION_ID) {
      send(actionId);
      return;
    }
    setNote('');
    setDrafting(actionId);
  }

  if (drafting) {
    return (
      <div className="flex flex-col gap-2">
        <textarea
          autoFocus
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={NOTE_PROMPT[drafting] ?? 'Add a note (optional)'}
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
          <Button size={size} variant="ghost" disabled={pending} onClick={() => setDrafting(null)}>
            Cancel
          </Button>
        </div>
        {approve.isError ? <p className="text-[11.5px] text-red">Could not submit the verdict. Try again.</p> : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <Button size={size} loading={pending} loadingText="Submitting…" onClick={() => onVerdict(APPROVE_ACTION_ID)}>
          {approveLabel}
        </Button>
        <Button size={size} variant="danger" disabled={pending} onClick={() => onVerdict(DENY_ACTION_ID)}>
          Deny
        </Button>
      </div>
      {approve.isError ? <p className="text-[11.5px] text-red">Could not submit the verdict. Try again.</p> : null}
    </div>
  );
}

/** Green confirmation bar that replaces the approval card after a ruling (a verdict_card over SSE). */
export function VerdictCardView({ card }: { card: WebVerdictCard }) {
  const approved = card.verdict === 'approve';
  const color = approved ? 'var(--green)' : 'var(--red)';
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
