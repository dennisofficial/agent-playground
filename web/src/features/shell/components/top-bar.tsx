'use client';

import Link from 'next/link';
import { Search } from 'lucide-react';
import { BrandLockup } from '@/components/ui/brand';
import { ROUTES } from '@/lib/routes';
import { OrgFilter } from './org-filter';
import { AccountMenu } from './account-menu';

/** Top bar (52px): lockup → Coordinator · repo picker · ⌘K palette trigger · key pill · avatar. */
export function TopBar({ onOpenPalette }: { onOpenPalette: () => void }) {
  return (
    <header
      className="flex h-[52px] shrink-0 items-center gap-3 border-b border-border px-4 backdrop-blur"
      style={{ background: 'color-mix(in srgb, var(--panel) 82%, transparent)' }}
    >
      <Link href={ROUTES.workspace()} className="shrink-0" aria-label="Coordinator overview">
        <BrandLockup size="sm" />
      </Link>
      <span className="h-[18px] w-px" style={{ background: 'var(--border-2)' }} />
      <OrgFilter />

      <button
        type="button"
        onClick={onOpenPalette}
        className="mx-auto flex h-8 w-full max-w-md items-center gap-2 rounded-md border border-border bg-surface-2 px-3 text-[12px] text-faint transition hover:bg-surface-3"
      >
        <Search size={13} />
        <span className="flex-1 text-left">Jump to a thread, run a command…</span>
        <kbd className="rounded border border-border-2 bg-surface px-1.5 py-0.5 font-mono text-[9.5px] text-dim">
          ⌘K
        </kbd>
      </button>

      <span
        className="hidden items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10.5px] font-medium md:inline-flex"
        style={{
          color: 'var(--green)',
          borderColor: 'var(--green-soft)',
          background: 'var(--green-soft)',
        }}
      >
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: 'var(--green)' }} />
        your key
      </span>

      <AccountMenu />
    </header>
  );
}
