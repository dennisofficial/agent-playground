'use client';

import { Button } from '@/components/ui/button';
import { useApprove } from '@/lib/api/queries';
import {
  APPROVE_ACTION_ID,
  DENY_ACTION_ID,
  REQUEST_CHANGES_ACTION_ID,
  type ApprovalActionId,
} from '@/lib/api/types';

export const RULED_BY = 'U-OPERATOR';

/**
 * The three plan-verdict buttons, shared by the conversation approval card and the full-plan page.
 * POSTs `/web/approve` with the card's verbatim `value`; the card re-emits as a verdict over SSE.
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

  function submit(actionId: ApprovalActionId) {
    if (!value) return;
    approve.mutate({ actionId, value, ruledBy: RULED_BY });
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <Button size={size} loading={pending} loadingText="Submitting…" onClick={() => submit(APPROVE_ACTION_ID)}>
          {approveLabel}
        </Button>
        <Button size={size} variant="ghost" disabled={pending} onClick={() => submit(REQUEST_CHANGES_ACTION_ID)}>
          Request changes
        </Button>
        <Button size={size} variant="danger" disabled={pending} onClick={() => submit(DENY_ACTION_ID)}>
          Deny
        </Button>
      </div>
      {approve.isError ? (
        <p className="text-[11.5px] text-red">Could not submit the verdict. Try again.</p>
      ) : null}
    </div>
  );
}
