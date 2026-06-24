'use client';

import { useState } from 'react';
import { ArrowUp } from 'lucide-react';
import { useSay } from '@/lib/api/thread-queries';
import type { ThreadRef } from '@/lib/api/thread-api';

/**
 * The conversation composer — talks to the thread's brain. Posts to `…/threads/:threadId/say`. Typed
 * ops ("pause", "approve", "resume", "simplify the rest"…) run the same operations as the buttons; the
 * brain interprets the text, so the composer just sends it. Enter sends; Shift+Enter newlines.
 */
export function Composer({
  threadRef,
  placeholder = 'Message Atlas — ask, plan, or steer…',
  hint,
}: {
  threadRef: ThreadRef;
  placeholder?: string;
  hint?: string;
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
      className="shrink-0 border-t border-border px-6 py-3"
      style={{ background: 'color-mix(in srgb, var(--panel) 45%, transparent)' }}
    >
      <div className="mx-auto flex max-w-[760px] items-end gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          placeholder={placeholder}
          className="max-h-40 min-h-[42px] flex-1 resize-none rounded-md border border-border-2 bg-surface px-3 py-2.5 text-[13px] text-text outline-none transition placeholder:text-faint focus:border-accent focus:ring-2 focus:ring-[var(--accent-soft)]"
        />
        <button
          type="button"
          onClick={send}
          disabled={!text.trim() || say.isPending}
          className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-md text-white transition hover:brightness-105 disabled:opacity-45"
          style={{ background: 'linear-gradient(145deg, var(--accent), var(--accent-2))' }}
          aria-label="Send"
        >
          <ArrowUp size={17} />
        </button>
      </div>
      {hint ? <p className="mt-1.5 text-center font-mono text-[9px] text-faint">{hint}</p> : null}
    </div>
  );
}
