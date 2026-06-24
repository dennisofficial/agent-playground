'use client';

import { useState } from 'react';
import Link from 'next/link';
import { KeyRound, Settings as SettingsIcon, Users } from 'lucide-react';
import { cn } from '@/lib/cn';
import { ROUTES, type SettingsSection } from '@/lib/routes';
import { BrandLockup } from '@/components/ui/brand';
import { AccountMenu } from '@/features/shell/components/account-menu';
import { useOrg, useOrgs } from '@/lib/api/me';
import { orgColor, orgInitials } from '@/lib/org-display';
import { GeneralSection } from './general-section';
import { CredentialsSection } from './credentials-section';
import { MembersSection } from './members-section';

const NAV: { id: SettingsSection; label: string; icon: typeof SettingsIcon }[] = [
  { id: 'general', label: 'General', icon: SettingsIcon },
  { id: 'credentials', label: 'Credentials', icon: KeyRound },
  { id: 'members', label: 'Members', icon: Users },
];

/** The Org & Settings screen — own top bar + a section nav (General / Credentials / Members). */
export function OrgSettings({
  orgId,
  initialSection,
}: {
  orgId: string;
  initialSection: SettingsSection;
}) {
  const { isLoading } = useOrgs();
  const org = useOrg(orgId);
  const [section, setSection] = useState<SettingsSection>(initialSection);

  return (
    <>
      {/* Top bar */}
      <header
        className="flex h-[52px] shrink-0 items-center gap-3.5 border-b border-border px-4 backdrop-blur"
        style={{ background: 'color-mix(in srgb, var(--panel) 82%, transparent)' }}
      >
        <Link href={ROUTES.workspace()} aria-label="Back to workspace">
          <BrandLockup size="sm" />
        </Link>
        <span className="h-[18px] w-px" style={{ background: 'var(--border-2)' }} />
        <div className="flex items-center gap-2 font-mono text-[11px] text-dim">
          <span className="text-faint">{org?.name ?? 'Organization'}</span>
          <span className="text-border-2">/</span>
          <span className="text-text">Settings</span>
        </div>
        <div className="flex-1" />
        <AccountMenu />
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Settings nav */}
        <nav
          className="flex w-[228px] shrink-0 flex-col gap-0.5 border-r border-border px-3 py-4"
          style={{ background: 'color-mix(in srgb, var(--panel) 60%, transparent)' }}
        >
          <div className="flex items-center gap-2.5 px-2 pb-3 pt-1.5">
            <span
              className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg font-disp text-[14px] font-semibold text-white"
              style={{ background: org ? orgColor(org.id) : 'var(--border-2)' }}
            >
              {org ? orgInitials(org.name) : '·'}
            </span>
            <div className="min-w-0">
              <div className="truncate text-[12.5px] font-semibold text-text">{org?.name ?? '—'}</div>
              <div
                className="font-mono text-[8.5px]"
                style={{ color: org?.status === 'active' ? 'var(--green)' : 'var(--faint)' }}
              >
                {org?.status ?? '—'}
              </div>
            </div>
          </div>
          <div className="px-2 pb-1.5 pt-1 font-mono text-[9px] tracking-[0.16em] text-faint">ORGANIZATION</div>
          {NAV.map(({ id, label, icon: Icon }) => {
            const on = section === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setSection(id)}
                className={cn(
                  'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[12.5px] font-medium transition',
                  on ? 'text-accent' : 'text-dim hover:bg-surface-2',
                )}
                style={on ? { background: 'var(--accent-soft)', boxShadow: 'inset 0 0 0 1px var(--accent-line)' } : undefined}
              >
                <Icon size={15} />
                {label}
              </button>
            );
          })}
        </nav>

        {/* Content */}
        <div className="min-w-0 flex-1 overflow-y-auto bg-surface">
          <div className="max-w-[640px] px-9 py-8 pb-16">
            {isLoading ? (
              <p className="text-[13px] text-faint">Loading…</p>
            ) : !org ? (
              <div className="rounded-lg border border-dashed border-border-2 px-6 py-14 text-center">
                <h2 className="text-[15px] font-semibold text-text">Organization not found</h2>
                <p className="mx-auto mt-1.5 max-w-sm text-[13px] text-dim">
                  This organization doesn’t exist or you don’t have access to it.
                </p>
                <Link href={ROUTES.workspace()} className="mt-4 inline-block text-[12.5px] font-medium text-accent">
                  ← Back to workspace
                </Link>
              </div>
            ) : section === 'general' ? (
              <GeneralSection org={org} />
            ) : section === 'credentials' ? (
              <CredentialsSection orgId={org.id} />
            ) : (
              <MembersSection orgId={org.id} orgName={org.name} />
            )}
          </div>
        </div>
      </div>
    </>
  );
}
