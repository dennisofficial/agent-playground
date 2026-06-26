'use client';

import { useState } from 'react';
import { ArrowUp, ChevronDown, Plus } from 'lucide-react';
import { useSay } from '@/lib/api/thread-queries';
import type { ThreadRef } from '@/lib/api/thread-api';

/**
 * The conversation composer — talks to the thread's brain. Posts to `…/threads/:threadId/say`. Typed
 * ops ("pause", "approve", "resume", "simplify the rest"…) run the same operations as the buttons; the
 * brain interprets the text, so the composer just sends it. Enter sends; Shift+Enter newlines.
 *
 * The `Plan ▾` mode pill, the `＋` attach button, and the model label are visual affordances from the
 * design and are intentionally static for now (no backend wiring) — see `web/BACKEND_GAPS.md`.
 */
export function Composer({
  threadRef,
  placeholder = 'Message Atlas — ask, plan, or steer…',
}: {
  threadRef: ThreadRef;
  placeholder?: string;
}) {
  const say = useSay(threadRef);
  const [text, setText] = useState('');

  function send() {
    const trimmed = text.trim();
    if (!trimmed) return;
    say.mutate(trimmed);
    setText('');
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div
      className="pointer-events-none absolute bottom-0 left-0 right-2 px-6 pb-5 pt-[22px]"
      style={{ background: 'linear-gradient(to top, var(--panel) 58%, transparent)' }}
    >
      <div className="pointer-events-auto mx-auto max-w-[880px]">
        <div
          className="rounded-2xl border border-border-2 bg-surface px-3 py-2.5"
          style={{ boxShadow: '0 8px 30px rgba(20,18,12,.14), 0 2px 8px rgba(20,18,12,.06)' }}
        >
          <div className="flex items-start gap-2.5">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKeyDown}
              rows={1}
              placeholder={placeholder}
              className="max-h-44 min-h-[24px] flex-1 resize-none bg-transparent pt-0.5 text-[13.5px] leading-relaxed text-text outline-none placeholder:text-faint"
            />
            <button
              type="button"
              onClick={send}
              disabled={!text.trim() || say.isPending}
              className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[9px] bg-accent text-white transition hover:brightness-105 disabled:opacity-45"
              aria-label="Send"
            >
              <ArrowUp size={15} strokeWidth={2.4} />
            </button>
          </div>

          {/* Static affordances (design parity — not wired yet) */}
          <div className="mt-2.5 flex items-center gap-2">
            <span className="flex items-center gap-1.5 rounded-lg border border-border-2 px-2.5 py-1 text-[12px] font-semibold text-text">
              Plan <ChevronDown size={11} strokeWidth={2.6} />
            </span>
            <span className="flex h-7 w-7 items-center justify-center rounded-lg text-dim">
              <Plus size={16} strokeWidth={2.2} />
            </span>
            <div className="flex-1" />
            <span className="font-mono text-[11px] text-dim">Opus 4.8 · Fast</span>
          </div>
        </div>
      </div>
    </div>
  );
}
