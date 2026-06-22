'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, GitBranch } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useChannel } from '@/components/providers/channel-provider';

/** Repo/channel picker chip (mono). Lists channels from `/web/channels`; selection persists. */
export function RepoPicker() {
  const { channels, activeChannel, setActiveChannel } = useChannel();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const label = activeChannel ?? 'no repo';

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1 font-mono text-[11px] text-dim transition hover:bg-surface-2"
      >
        <GitBranch size={12} className="text-faint" />
        <span className="max-w-[180px] truncate text-text">{label}</span>
        <ChevronDown size={12} className="text-faint" />
      </button>

      {open ? (
        <div
          className="absolute left-0 top-[calc(100%+6px)] z-50 min-w-[220px] overflow-hidden rounded-md border border-border bg-panel py-1"
          style={{ boxShadow: 'var(--shadow-menu)' }}
        >
          {channels.length === 0 ? (
            <div className="px-3 py-2 text-[12px] text-faint">No active channels yet</div>
          ) : (
            channels.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => {
                  setActiveChannel(c);
                  setOpen(false);
                }}
                className={cn(
                  'flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-[11.5px] transition hover:bg-surface-2',
                  c === activeChannel ? 'text-text' : 'text-dim',
                )}
              >
                <Check size={12} className={c === activeChannel ? 'text-accent' : 'opacity-0'} />
                <span className="truncate">{c}</span>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
