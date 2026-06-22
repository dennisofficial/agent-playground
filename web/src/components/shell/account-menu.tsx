'use client';

import { useEffect, useRef, useState } from 'react';
import { LogOut, Settings, Users } from 'lucide-react';
import { auth } from '@/lib/auth';
import { ROUTES } from '@/lib/routes';

const NAME = 'Dennis Lysenko';
const EMAIL = 'dennis@atlas.dev';

function initials(name: string): string {
  return name
    .split(' ')
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

/** Avatar + account menu (Signed in as / Workspace settings / Switch account / Sign out). */
export function AccountMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

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
        {initials(NAME)}
      </button>

      {open ? (
        <div
          className="absolute right-0 top-[calc(100%+8px)] z-50 w-60 overflow-hidden rounded-md border border-border bg-panel py-1.5"
          style={{ boxShadow: 'var(--shadow-menu)' }}
        >
          <div className="px-3 pb-2 pt-1">
            <p className="text-[10px] uppercase tracking-wider text-faint">Signed in as</p>
            <p className="mt-0.5 text-[13px] font-medium text-text">{NAME}</p>
            <p className="font-mono text-[10.5px] text-dim">{EMAIL}</p>
          </div>
          <div className="my-1 h-px" style={{ background: 'var(--hair)' }} />
          <MenuItem icon={<Settings size={14} />} label="Workspace settings" />
          <MenuItem icon={<Users size={14} />} label="Switch account" />
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

function MenuItem({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <button
      type="button"
      className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[12.5px] text-dim transition hover:bg-surface-2 hover:text-text"
    >
      {icon}
      {label}
    </button>
  );
}
