'use client';

import { SwitchRow } from '@/features/job-workspace/auto-approve-popover';
import type { OrgSummary } from '@/lib/api/me';
import { useUpdateOrgMutation } from '@/redux/query/api/org.api';
import { useState } from 'react';

/**
 * Automation settings — the org-level defaults a new job inherits at creation (the create-job form seeds
 * its Plan/Ship/Merge toggles from these). Owner-only, same PATCH /orgs/:orgId as General. Each of the
 * three toggles maps 1:1 to a backend boolean default.
 */
export function AutomationSection({ org }: { org: OrgSummary }) {
  const isOwner = org.role === 'owner';
  const [update, updateState] = useUpdateOrgMutation();
  const [autoApprove, setAutoApprove] = useState(org.defaultAutoApprove);
  const [autoShip, setAutoShip] = useState(org.defaultAutoShip);
  const [autoMerge, setAutoMerge] = useState(org.defaultAutoMerge);

  const dirty =
    autoApprove !== org.defaultAutoApprove ||
    autoShip !== org.defaultAutoShip ||
    autoMerge !== org.defaultAutoMerge;

  function toggle(setter: (v: boolean) => void, next: boolean) {
    setter(next);
    updateState.reset();
  }

  function save() {
    if (!isOwner || !dirty || updateState.isLoading) return;
    update({
      orgId: org.id,
      body: {
        defaultAutoApprove: autoApprove,
        defaultAutoShip: autoShip,
        defaultAutoMerge: autoMerge,
      },
    });
  }

  return (
    <>
      <h1 className="font-disp text-[22px] font-semibold tracking-[-0.01em] text-text">
        Automation
      </h1>
      <p className="mb-7 mt-1.5 text-[13px] text-dim">
        Defaults new jobs in this org inherit. You can still override them per job.
      </p>

      <div
        className={
          isOwner
            ? 'rounded-md border border-border-2 px-3 pt-1.5 pb-1'
            : 'pointer-events-none rounded-md border border-border-2 px-3 pt-1.5 pb-1 opacity-60'
        }
      >
        <SwitchRow
          title="Plan"
          description="Approve the plan / direct-build gate automatically"
          checked={autoApprove}
          first
          testId="org-default-auto-approve-plan"
          onChange={(next) => toggle(setAutoApprove, next)}
        />
        <SwitchRow
          title="Ship"
          description="Approve the ship-review gate automatically"
          checked={autoShip}
          testId="org-default-auto-approve-ship"
          onChange={(next) => toggle(setAutoShip, next)}
        />
        <SwitchRow
          title="Merge"
          description="Merge the PR automatically once it's green & mergeable"
          checked={autoMerge}
          testId="org-default-auto-merge"
          onChange={(next) => toggle(setAutoMerge, next)}
        />
      </div>

      <div className="mt-4 flex items-center gap-2.5">
        <button
          type="button"
          onClick={save}
          disabled={!isOwner || !dirty || updateState.isLoading}
          title={isOwner ? undefined : 'Only the organization owner can change these settings'}
          className="rounded-md px-4 py-2 text-[12.5px] font-semibold text-white transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-45"
          style={{ background: 'var(--accent)' }}
        >
          {updateState.isLoading ? 'Saving…' : 'Save changes'}
        </button>
        {updateState.isSuccess && !dirty ? (
          <span className="text-[11.5px] text-green">✓ Saved</span>
        ) : null}
        {updateState.isError ? (
          <span className="text-[11.5px] text-red">
            {(updateState.error as Error)?.message ?? 'Could not save changes.'}
          </span>
        ) : null}
      </div>
      {!isOwner ? (
        <p className="mt-3 text-[11px] text-faint">
          Only the organization owner can change these settings.
        </p>
      ) : null}
    </>
  );
}
