"use client";

import { useState } from "react";
import {
  type AutoApproveMode,
  modeApprovesPlan,
  modeApprovesShip,
} from "@workspace/shared";
import { composeMode } from "@/features/job-workspace/auto-approve-mode";
import { SwitchRow } from "@/features/job-workspace/auto-approve-popover";
import type { OrgSummary } from "@/lib/api/me";
import { useUpdateOrg } from "@/lib/api/orgs";

/**
 * Automation settings — the org-level defaults a new job inherits at creation (the create-job form seeds
 * its Plan/Ship/Merge toggles from these). Owner-only, same PATCH /web/orgs/:orgId as General.
 */
export function AutomationSection({ org }: { org: OrgSummary }) {
  const isOwner = org.role === "owner";
  const update = useUpdateOrg(org.id);
  const [mode, setMode] = useState<AutoApproveMode>(org.defaultAutoApproveMode);
  const [autoMerge, setAutoMerge] = useState(org.defaultAutoMerge);

  const dirty =
    mode !== org.defaultAutoApproveMode || autoMerge !== org.defaultAutoMerge;

  function onMode(next: AutoApproveMode) {
    setMode(next);
    update.reset();
  }

  function onAutoMerge(next: boolean) {
    setAutoMerge(next);
    update.reset();
  }

  function save() {
    if (!isOwner || !dirty || update.isPending) return;
    update.mutate({ defaultAutoApproveMode: mode, defaultAutoMerge: autoMerge });
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
            ? "rounded-md border border-border-2 px-3 pt-1.5 pb-1"
            : "pointer-events-none rounded-md border border-border-2 px-3 pt-1.5 pb-1 opacity-60"
        }
      >
        <SwitchRow
          title="Plan"
          description="Approve the plan / direct-build gate automatically"
          checked={modeApprovesPlan(mode)}
          first
          testId="org-default-auto-approve-plan"
          onChange={(next) => onMode(composeMode(next, modeApprovesShip(mode)))}
        />
        <SwitchRow
          title="Ship"
          description="Approve the ship-review gate automatically"
          checked={modeApprovesShip(mode)}
          testId="org-default-auto-approve-ship"
          onChange={(next) => onMode(composeMode(modeApprovesPlan(mode), next))}
        />
        <SwitchRow
          title="Merge"
          description="Merge the PR automatically once it's green & mergeable"
          checked={autoMerge}
          testId="org-default-auto-merge"
          onChange={onAutoMerge}
        />
      </div>

      <div className="mt-4 flex items-center gap-2.5">
        <button
          type="button"
          onClick={save}
          disabled={!isOwner || !dirty || update.isPending}
          title={
            isOwner
              ? undefined
              : "Only the organization owner can change these settings"
          }
          className="rounded-md px-4 py-2 text-[12.5px] font-semibold text-white transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-45"
          style={{ background: "var(--accent)" }}
        >
          {update.isPending ? "Saving…" : "Save changes"}
        </button>
        {update.isSuccess && !dirty ? (
          <span className="text-[11.5px] text-green">✓ Saved</span>
        ) : null}
        {update.isError ? (
          <span className="text-[11.5px] text-red">
            {(update.error as Error)?.message ?? "Could not save changes."}
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
