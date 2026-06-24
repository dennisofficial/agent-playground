'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { LogOut, Settings } from 'lucide-react';
import { useCurrentUser, useOrgs } from '@/lib/api/me';
import { useOrgFilter } from '@/components/providers/orgs-provider';
import { orgColor } from '@/lib/org-display';
import { auth } from '@/lib/auth';
import { ROUTES } from '@/lib/routes';

/**
 * Derive a display handle + avatar initials from the operator's email. The backend doesn't store a
 * display name this phase, so the email local-part stands in (split on `. _ -` when present).
 */
function identityFromEmail(email: string | undefined): { name: string; email: string; initials: string } {
  if (!email) return { name: 'Account', email: '', initials: '··' };
  const local = email.split('@')[0] || email;
  const parts = local.split(/[._-]+/).filter(Boolean);
  const initials = (parts.length >= 2 ? parts[0][0] + parts[1][0] : local.slice(0, 2)).toUpperCase();
  const name =
    parts.length >= 2 ? parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ') : local;
  return { name, email, initials };
}

/** Avatar + account menu (Signed in as / Workspace settings / Switch account / Sign out). */
export function AccountMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { data: me } = useCurrentUser();
  const { orgs, owned, joined } = useOrgs();
  const { filter } = useOrgFilter();
  const identity = identityFromEmail(me?.email);
  // Settings is per-org, and this is the ONLY entry point — so it must follow the active rail/filter
  // selection, not be pinned to the first org. When the filter is "All" (no single org) fall back to the
  // operator's primary org (owned first, else joined). `selectedOrg` is set only on a real selection, so
  // the sub-label can mark it "· current" vs. a silent fallback.
  const selectedOrg = filter !== 'all' ? orgs.find((o) => o.id === filter) : undefined;
  const targetOrg = selectedOrg ?? owned[0] ?? joined[0];

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  function signOut() {
    auth.signOut();
    // Hard nav so the signed-out screen wins the race against the PrivateGuard's
    // unauthenticated → /auth/login redirect on the current protected route.
    window.location.assign(ROUTES.auth.signedOut());
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-semibold text-white"
        style={{ background: 'linear-gradient(145deg, var(--accent), var(--accent-2))' }}
        aria-label="Account"
      >
        {identity.initials}
      </button>

      {open ? (
        <div
          className="absolute right-0 top-[calc(100%+8px)] z-50 w-60 overflow-hidden rounded-md border border-border bg-panel py-1.5"
          style={{ boxShadow: 'var(--shadow-menu)' }}
        >
          <div className="px-3 pb-2 pt-1">
            <p className="text-[10px] uppercase tracking-wider text-faint">Signed in as</p>
            <p className="mt-0.5 text-[13px] font-medium text-text">{identity.name}</p>
            {identity.email ? (
              <p className="font-mono text-[10.5px] text-dim">{identity.email}</p>
            ) : null}
          </div>
          <div className="my-1 h-px" style={{ background: 'var(--hair)' }} />
          {targetOrg ? (
            <Link
              href={ROUTES.orgSettings(targetOrg.id)}
              onClick={() => setOpen(false)}
              className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[12.5px] text-dim transition hover:bg-surface-2 hover:text-text"
            >
              <Settings size={14} className="mt-0.5 shrink-0 self-start" />
              <span className="min-w-0 flex-1">
                <span className="block truncate">Organization settings</span>
                <span className="mt-0.5 flex items-center gap-1.5">
                  <span
                    className="h-[7px] w-[7px] shrink-0 rounded-[2px]"
                    style={{ background: orgColor(targetOrg.id) }}
                  />
                  <span className="truncate font-mono text-[9px] text-faint">
                    {targetOrg.name}
                    {selectedOrg ? ' · current' : ''}
                  </span>
                </span>
              </span>
            </Link>
          ) : null}
          <div className="my-1 h-px" style={{ background: 'var(--hair)' }} />
          <button
            type="button"
            onClick={signOut}
            className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[12.5px] text-red transition hover:bg-surface-2"
          >
            <LogOut size={14} /> Sign out
          </button>
        </div>
      ) : null}
    </div>
  );
}
