'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Building2, LogOut, Settings } from 'lucide-react';
import { useCurrentUser, useOrgs, type CurrentUser } from '@/lib/api/me';
import { orgColor } from '@/lib/org-display';
import { auth } from '@/lib/auth';
import { ROUTES } from '@/lib/routes';
import { CreateOrgDialog } from './create-org-dialog';

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

/** First name for the sidebar greeting — the session name if present, else the email handle. Capitalized. */
function firstNameOf(me: CurrentUser | undefined, fallbackName: string): string {
  const raw = (me?.name?.trim().split(/\s+/)[0] || fallbackName.split(' ')[0] || 'there').trim();
  return raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : 'there';
}

/**
 * Account menu — the avatar/greeting trigger + a panel (signed-in-as · org settings · create org · sign
 * out). Shared by the sidebar header (`variant="sidebar"`: avatar + "What's next, {name}?") and the
 * settings top bar (`variant="avatar"`: a round initials button). Settings is per-org and this is one of
 * its entry points, so it targets the operator's primary org (owned first, else joined).
 */
export function AccountMenu({ variant = 'avatar' }: { variant?: 'avatar' | 'sidebar' }) {
  const [open, setOpen] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { data: me } = useCurrentUser();
  const { owned, joined } = useOrgs();
  const identity = identityFromEmail(me?.email);
  const targetOrg = owned[0] ?? joined[0];

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

  const isSidebar = variant === 'sidebar';

  return (
    <div className="relative" ref={ref}>
      {isSidebar ? (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-center gap-2.5 rounded-md px-1 py-1 text-left transition hover:bg-surface-2"
          aria-label="Account"
        >
          <Avatar />
          <span className="min-w-0 flex-1 truncate font-disp text-[13.5px] font-semibold tracking-[-0.01em] text-text">
            What&apos;s next, {firstNameOf(me, identity.name)}?
          </span>
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-semibold text-white"
          style={{ background: 'linear-gradient(145deg, var(--accent), var(--accent-2))' }}
          aria-label="Account"
        >
          {identity.initials}
        </button>
      )}

      {open ? (
        <div
          className={`absolute z-50 w-60 overflow-hidden rounded-md border border-border bg-panel py-1.5 ${
            isSidebar ? 'left-0 top-[calc(100%+6px)]' : 'right-0 top-[calc(100%+8px)]'
          }`}
          style={{ boxShadow: 'var(--shadow-menu)' }}
        >
          <div className="px-3 pb-2 pt-1">
            <p className="text-[10px] uppercase tracking-wider text-faint">Signed in as</p>
            <p className="mt-0.5 text-[13px] font-medium text-text">{identity.name}</p>
            {identity.email ? <p className="font-mono text-[10.5px] text-dim">{identity.email}</p> : null}
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
                  <span className="truncate font-mono text-[9px] text-faint">{targetOrg.name}</span>
                </span>
              </span>
            </Link>
          ) : null}
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              setShowCreate(true);
            }}
            className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[12.5px] text-dim transition hover:bg-surface-2 hover:text-text"
          >
            <Building2 size={14} className="shrink-0" /> Create organization
          </button>
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

      {showCreate ? <CreateOrgDialog onClose={() => setShowCreate(false)} /> : null}
    </div>
  );
}

/** The round person-silhouette avatar from the design's sidebar header. */
function Avatar() {
  return (
    <span
      className="flex h-8 w-8 shrink-0 items-end justify-center overflow-hidden rounded-full border border-border-2"
      style={{ background: '#e6e4de', boxShadow: '0 1px 3px rgba(0,0,0,0.08)' }}
    >
      <svg width="32" height="32" viewBox="0 0 64 64" className="block" aria-hidden>
        <circle cx="32" cy="26" r="12" fill="#b6b9c1" />
        <path d="M12 59c0-11 9-18 20-18s20 7 20 18z" fill="#b6b9c1" />
      </svg>
    </span>
  );
}
