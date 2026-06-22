'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useApprove } from '@/lib/api/mutations';
import {
  APPROVE_ACTION_ID,
  DENY_ACTION_ID,
  REQUEST_CHANGES_ACTION_ID,
  type ApprovalActionId,
} from '@/lib/api/types';

export const RULED_BY = 'U-OPERATOR';

/** Negative verdicts reveal an optional reason (`note`) before submitting. */
const NOTE_PROMPT: Partial<Record<ApprovalActionId, string>> = {
  [REQUEST_CHANGES_ACTION_ID]: 'What should change? (optional)',
  [DENY_ACTION_ID]: 'Why deny this? (optional)',
};

/**
 * The three plan-verdict buttons, shared by the conversation approval card and the full-plan page.
 * POSTs `/web/approve` with the card's verbatim `value`; the card re-emits as a verdict over SSE.
 * Approve is one-click; Request-changes / Deny first reveal an optional `note` — it rides through to
 * `DecisionApprovalService.resolve` and the brain reads `resolution.note` (BACKEND_GAPS #5).
 */
export function VerdictButtons({
  value,
  approveLabel = 'Approve',
  size = 'sm',
}: {
  value: string;
  approveLabel?: string;
  size?: 'sm' | 'md';
}) {
  const approve = useApprove();
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
    const denying = drafting === DENY_ACTION_ID;
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
            variant={denying ? 'danger' : 'primary'}
            loading={pending}
            loadingText="Submitting…"
            onClick={() => {
              send(drafting, note);
              setDrafting(null);
            }}
          >
            {denying ? 'Deny' : 'Request changes'}
          </Button>
          <Button size={size} variant="ghost" disabled={pending} onClick={() => setDrafting(null)}>
            Cancel
          </Button>
        </div>
        {approve.isError ? (
          <p className="text-[11.5px] text-red">Could not submit the verdict. Try again.</p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <Button size={size} loading={pending} loadingText="Submitting…" onClick={() => onVerdict(APPROVE_ACTION_ID)}>
          {approveLabel}
        </Button>
        <Button size={size} variant="ghost" disabled={pending} onClick={() => onVerdict(REQUEST_CHANGES_ACTION_ID)}>
          Request changes
        </Button>
        <Button size={size} variant="danger" disabled={pending} onClick={() => onVerdict(DENY_ACTION_ID)}>
          Deny
        </Button>
      </div>
      {approve.isError ? (
        <p className="text-[11.5px] text-red">Could not submit the verdict. Try again.</p>
      ) : null}
    </div>
  );
}
