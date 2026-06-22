'use client';

import { useState } from 'react';
import { Info } from 'lucide-react';
import type { PhaseTab } from '@/lib/routes';
import { useThreadMessages } from '@/lib/api/messages';
import { useSay } from '@/lib/api/mutations';

/**
 * Build-phase body. Per-phase transcript/diff/logs are NOT exposed by `/web/*` (BACKEND_GAPS.md #9),
 * so the transcript shows the thread's live `build_event` relays as a stand-in and diff/logs are
 * placeholders. The interject bar posts into the thread (folds in at the next turn boundary).
 */
export function BuildPhase({
  channel,
  threadTs,
  tab,
}: {
  channel: string;
  threadTs: string;
  tab: PhaseTab;
}) {
  const { messages } = useThreadMessages(channel, threadTs);
  const buildEvents = messages.filter(
    (m) => (m.meta as { kind?: string } | undefined)?.kind === 'build_event',
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        {tab === 'transcript' ? (
          <Transcript lines={buildEvents.map((m) => m.text)} />
        ) : (
          <Placeholder
            title={tab === 'diff' ? 'Diff' : 'Logs'}
            body={`The per-phase ${tab} stream isn't exposed by the web surface yet. It will render here once the backend adds a phase read endpoint.`}
          />
        )}
      </div>
      <InterjectBar channel={channel} threadTs={threadTs} />
    </div>
  );
}

function Transcript({ lines }: { lines: string[] }) {
  return (
    <div className="flex flex-col gap-2 font-mono text-[12px]">
      <PlaceholderBanner text="Showing live build-event relays from the thread (per-phase transcript pending a backend endpoint)." />
      {lines.length === 0 ? (
        <p className="text-faint">No build activity relayed yet.</p>
      ) : (
        lines.map((line, i) => (
          <div key={i} className="rounded-md border border-border bg-surface px-3 py-2 text-dim">
            {line}
          </div>
        ))
      )}
      <span className="cursor-blink inline-block h-3.5 w-1.5 bg-[var(--accent)]" aria-hidden />
    </div>
  );
}

function Placeholder({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <p className="text-[14px] font-semibold text-text">{title}</p>
      <p className="mt-1.5 max-w-md text-[12.5px] text-dim">{body}</p>
    </div>
  );
}

function PlaceholderBanner({ text }: { text: string }) {
  return (
    <div className="mb-1 flex items-start gap-2 rounded-md border border-border bg-surface-2 px-3 py-2 text-[11px] text-dim">
      <Info size={13} className="mt-px shrink-0 text-faint" />
      <span className="font-sans">{text}</span>
    </div>
  );
}

/** Talks to the build session (via the thread). Pause / Revert / Auto-advance are UI-only today. */
function InterjectBar({ channel, threadTs }: { channel: string; threadTs: string }) {
  const say = useSay();
  const [text, setText] = useState('');
  const [queued, setQueued] = useState<string[]>([]);

  function send() {
    const trimmed = text.trim();
    if (!trimmed) return;
    say.mutate({ channel, text: trimmed, threadTs });
    setQueued((q) => [...q, trimmed]);
    setText('');
  }

  return (
    <div className="shrink-0 border-t border-border bg-panel px-6 py-3">
      {queued.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {queued.map((q, i) => (
            <span
              key={i}
              className="rounded-full border border-border bg-surface-2 px-2 py-0.5 font-mono text-[10px] text-dim"
            >
              ↳ {q.length > 40 ? `${q.slice(0, 39)}…` : q}
            </span>
          ))}
        </div>
      ) : null}
      <div className="flex items-center gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') send();
          }}
          placeholder="Interject — folds in at the next turn boundary, no restart…"
          className="h-9 flex-1 rounded-md border border-border-2 bg-surface px-3 text-[12.5px] text-text outline-none placeholder:text-faint focus:border-accent"
        />
        <button
          type="button"
          onClick={send}
          disabled={!text.trim()}
          className="h-9 rounded-md px-3 text-[12px] font-medium text-white disabled:opacity-45"
          style={{ background: 'linear-gradient(145deg, var(--accent), var(--accent-2))' }}
        >
          Interject
        </button>
      </div>
      <div className="mt-2 flex gap-2 text-[11px] text-faint">
        <button type="button" disabled className="rounded border border-border px-2 py-0.5" title="Needs a backend pause route">
          Pause
        </button>
        <button type="button" disabled className="rounded border border-border px-2 py-0.5" title="Needs a backend revert route">
          Revert phase
        </button>
        <span className="rounded border border-border px-2 py-0.5">Auto-advance</span>
      </div>
    </div>
  );
}
