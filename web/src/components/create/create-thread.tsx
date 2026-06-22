'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, GitBranch, Plug } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import { useChannels, useSay } from '@/lib/api/queries';
import { encodeThreadKey, ROUTES } from '@/lib/routes';

/**
 * Create-thread form — shared by the `@dialog` modal and the `/new` full-page fallback (single source).
 * Picks a repo (channel) + base branch, takes a required first message, and posts it via `/web/say`
 * (no threadTs → starts a thread), then routes to the new thread. Repo/branch listing + onboarding
 * status have no API yet (BACKEND_GAPS.md #10) — branch is a free-text field, defaulting to `main`.
 */
export function CreateThread({ onDone }: { onDone?: () => void }) {
  const router = useRouter();
  const { data: channels = [], isLoading } = useChannels();
  const say = useSay();

  const [channel, setChannel] = useState<string>('');
  const [branch, setBranch] = useState('main');
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!channel && channels.length > 0) setChannel(channels[0]);
  }, [channels, channel]);

  if (isLoading) {
    return <p className="py-6 text-center text-[13px] text-faint">Loading repos…</p>;
  }

  if (channels.length === 0) {
    return <OnboardingState />;
  }

  function create() {
    const text = message.trim();
    if (!channel) {
      setError('Pick a repo to start a thread.');
      return;
    }
    if (!text) {
      setError('Add a first message — it starts the thread.');
      return;
    }
    setError(null);
    say.mutate(
      { channel, text },
      {
        onSuccess: (data) => {
          router.push(ROUTES.thread(encodeThreadKey(channel, data.ts)));
          onDone?.();
        },
        onError: () => setError('Could not start the thread. Try again.'),
      },
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-[12px] font-medium text-dim">Repo &amp; branch</p>
        <div className="mt-1.5 flex gap-2">
          <RepoSelect channels={channels} value={channel} onChange={setChannel} />
          <div className="flex h-10 items-center gap-1.5 rounded-md border border-border-2 bg-surface px-2.5">
            <GitBranch size={13} className="text-faint" />
            <input
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              className="w-28 bg-transparent font-mono text-[11.5px] text-text outline-none"
              aria-label="Base branch"
            />
          </div>
        </div>
        <p className="mt-1 font-mono text-[9.5px] text-faint">
          branch listing isn&apos;t available yet — type a base branch
        </p>
      </div>

      <div>
        <p className="text-[12px] font-medium text-dim">First message</p>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={4}
          placeholder="Describe the work — sent as your first message the moment the workspace is ready…"
          className="mt-1.5 w-full resize-none rounded-md border border-border-2 bg-surface px-3 py-2.5 text-[13px] text-text outline-none placeholder:text-faint focus:border-accent focus:ring-2 focus:ring-[var(--accent-soft)]"
        />
      </div>

      {error ? <p className="text-[12px] text-red">{error}</p> : null}

      <div className="flex justify-end">
        <Button onClick={create} loading={say.isPending} loadingText="Starting…">
          Create thread
        </Button>
      </div>
    </div>
  );
}

function RepoSelect({
  channels,
  value,
  onChange,
}: {
  channels: string[];
  value: string;
  onChange: (c: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  return (
    <div className="relative flex-1" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex h-10 w-full items-center gap-2 rounded-md border border-border-2 bg-surface px-3 font-mono text-[11.5px] text-text"
      >
        <span className="flex-1 truncate text-left">{value || 'Select a repo'}</span>
        <ChevronDown size={13} className="text-faint" />
      </button>
      {open ? (
        <div
          className="absolute left-0 top-[calc(100%+6px)] z-50 max-h-56 w-full overflow-y-auto rounded-md border border-border bg-panel py-1"
          style={{ boxShadow: 'var(--shadow-menu)' }}
        >
          {channels.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => {
                onChange(c);
                setOpen(false);
              }}
              className={cn(
                'flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-[11.5px] hover:bg-surface-2',
                c === value ? 'text-text' : 'text-dim',
              )}
            >
              <Check size={12} className={c === value ? 'text-accent' : 'opacity-0'} />
              <span className="truncate">{c}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Onboarding empty state — no repo bound yet (engine creds + repo connection have no status API). */
function OnboardingState() {
  return (
    <div className="flex flex-col items-center rounded-md border border-dashed border-border-2 px-5 py-10 text-center">
      <span className="flex h-11 w-11 items-center justify-center rounded-full" style={{ background: 'var(--surface-2)' }}>
        <Plug size={18} className="text-dim" />
      </span>
      <h3 className="mt-3 text-[14px] font-semibold text-text">Connect a repo first</h3>
      <p className="mt-1.5 max-w-xs text-[12.5px] text-dim">
        Finish setup to create threads — connect your engine credentials and bind a repository. Once
        Atlas posts to a channel, it becomes available here.
      </p>
    </div>
  );
}
