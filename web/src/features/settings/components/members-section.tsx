'use client';

import { useGetOrgMembersQuery } from '@/redux/query/api/org.api';
import { orgColor, orgInitials, roleLabel } from '@/utils/org-display';
import type { MemberView } from '@workspace/shared';
import { UserPlus } from 'lucide-react';

/**
 * Members — the org's people + roles. Read-only this phase: invites exist server-side but are gated
 * behind a follow-up (the rows carry live tokens), so the Invite control is a "coming soon" affordance,
 * matching the design.
 */
export function MembersSection({ orgId, orgName }: { orgId: string; orgName: string }) {
  const {
    data: members,
    isLoading,
    isError,
  } = useGetOrgMembersQuery(orgId, {
    skip: !orgId,
  });

  return (
    <>
      <div className="flex items-start gap-3.5">
        <div className="flex-1">
          <h1 className="font-disp text-[22px] font-semibold tracking-[-0.01em] text-text">
            Members
          </h1>
          <p className="mt-1.5 text-[13px] text-dim">People with access to {orgName}.</p>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <span className="flex cursor-not-allowed items-center gap-1.5 rounded-md border border-dashed border-border-2 bg-surface-2 px-3.5 py-2 text-[12.5px] font-semibold text-faint">
            <UserPlus size={14} />
            Invite
          </span>
          <span className="rounded-full border border-accent-line bg-accent-soft px-2 py-0.5 font-mono text-[9px] text-accent">
            coming soon
          </span>
        </div>
      </div>

      <div className="mt-6 overflow-hidden rounded-lg border border-border">
        <div
          className="flex items-center px-4 py-2.5 font-mono text-[9px] uppercase tracking-[0.1em] text-faint"
          style={{
            background: 'var(--surface-2)',
            borderBottom: '1px solid var(--border)',
          }}
        >
          <span className="flex-1">Member</span>
          <span className="w-28">Role</span>
        </div>

        {isLoading ? (
          <p className="px-4 py-5 text-[12.5px] text-faint">Loading members…</p>
        ) : isError ? (
          <p className="px-4 py-5 text-[12.5px] text-red">Couldn’t load members.</p>
        ) : (members?.length ?? 0) === 0 ? (
          <p className="px-4 py-5 text-[12.5px] text-faint">No members.</p>
        ) : (
          members!.map((m) => <MemberRow key={m.userId} member={m} />)
        )}
      </div>

      <p className="mt-3.5 text-[11.5px] leading-relaxed text-faint">
        Invites are coming in a follow-up. For now, members are provisioned by the org owner.
      </p>
    </>
  );
}

function MemberRow({ member }: { member: MemberView }) {
  const display = member.name?.trim() || member.email.split('@')[0] || member.email;
  const isOwner = member.role === 'owner';
  return (
    <div
      className="flex items-center px-4 py-3.5"
      style={{ borderBottom: '1px solid var(--hair)' }}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <span
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full font-disp text-[12px] font-semibold text-white"
          style={{ background: orgColor(member.userId) }}
        >
          {orgInitials(display)}
        </span>
        <div className="min-w-0">
          <div className="truncate text-[12.5px] font-semibold text-text">{display}</div>
          <div className="truncate font-mono text-[10px] text-faint">{member.email}</div>
        </div>
      </div>
      <div className="w-28">
        <span
          className="rounded-full border px-2.5 py-0.5 text-[10.5px] font-semibold"
          style={{
            color: isOwner ? 'var(--accent)' : 'var(--dim)',
            background: isOwner ? 'var(--accent-soft)' : 'var(--surface-2)',
            borderColor: isOwner ? 'var(--accent-line)' : 'var(--border-2)',
          }}
        >
          {roleLabel(member.role)}
        </span>
      </div>
    </div>
  );
}
