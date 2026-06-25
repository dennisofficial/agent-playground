'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Search } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useAllThreads, type InboxThread } from '@/lib/api/inbox';
import { orgSwatch } from '@/lib/org-display';
import { threadHref } from '@/lib/routes';

/**
 * ⌘K command palette — cross-org thread search over `GET /web/threads`. Picking a result opens its thread
 * workspace. `esc` closes (handled by the host).
 */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const { data: threads = [] } = useAllThreads();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  function openThread(t: InboxThread) {
    router.push(threadHref({ orgId: t.org.id, repoId: t.repo.id, threadId: t.id }));
    onClose();
  }

  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
      const id = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
  }, [open]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? threads.filter(
          (t) =>
            t.title.toLowerCase().includes(q) ||
            t.org.name.toLowerCase().includes(q) ||
            t.repo.name.toLowerCase().includes(q),
        )
      : threads;
    return list.slice(0, 8);
  }, [threads, query]);

  if (!open) return null;

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(results.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const pick = results[active];
      if (pick) openThread(pick);
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center px-4 pt-[12vh]" onMouseDown={onClose}>
      <div className="absolute inset-0" style={{ background: 'rgba(0,0,0,0.4)' }} />
      <div
        className="anim-pop relative w-full max-w-xl overflow-hidden rounded-lg border border-border bg-panel"
        style={{ boxShadow: 'var(--shadow-palette)' }}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal
      >
        <div className="flex items-center gap-2.5 border-b border-border px-4">
          <Search size={15} className="text-faint" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Search threads across all organizations…"
            className="h-12 flex-1 bg-transparent text-[14px] text-text outline-none placeholder:text-faint"
          />
          <kbd className="rounded border border-border-2 bg-surface px-1.5 py-0.5 font-mono text-[9.5px] text-dim">
            esc
          </kbd>
        </div>
        <div className="max-h-80 overflow-y-auto p-1.5">
          {results.length === 0 ? (
            <p className="px-3 py-6 text-center text-[12.5px] text-faint">No matching threads</p>
          ) : (
            results.map((t, i) => (
              <button
                key={t.id}
                type="button"
                onMouseEnter={() => setActive(i)}
                onClick={() => openThread(t)}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left',
                  i === active ? 'bg-surface-2' : '',
                )}
              >
                <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: orgSwatch() }} />
                <span className="min-w-0 flex-1 truncate text-[13px] text-text">{t.title}</span>
                <span className="shrink-0 font-mono text-[10px] text-faint">
                  {t.org.name} · {t.repo.name}
                </span>
              </button>
            ))
          )}
        </div>
        <div className="border-t border-border px-4 py-2 font-mono text-[9.5px] text-faint">
          ↑↓ to navigate · ↵ to open · esc to close
        </div>
      </div>
    </div>
  );
}
