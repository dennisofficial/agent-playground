'use client';

import { useState } from 'react';
import { ArrowUp } from 'lucide-react';
import { useSay } from '@/lib/api/queries';

/**
 * Conversation composer. Posts to `/web/say` in the current thread. Typed ops ("pause", "approve",
 * "resume", "request changes"…) run the same deterministic ops as the buttons — the brain interprets
 * the text, so the composer just sends it. Enter sends; Shift+Enter newlines.
 */
export function Composer({
  channel,
  threadTs,
  placeholder = 'Message Atlas — ask, plan, or steer…',
}: {
  channel: string;
  threadTs?: string;
  placeholder?: string;
}) {
  const say = useSay();
  const [text, setText] = useState('');

  function send() {
    const trimmed = text.trim();
    if (!trimmed) return;
    say.mutate({ channel, text: trimmed, threadTs });
    setText('');
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div className="border-t border-border bg-panel px-6 py-3">
      <div className="mx-auto flex max-w-[760px] items-end gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          placeholder={placeholder}
          className="max-h-40 min-h-[42px] flex-1 resize-none rounded-md border border-border-2 bg-surface px-3 py-2.5 text-[13.5px] text-text outline-none transition placeholder:text-faint focus:border-accent focus:ring-2 focus:ring-[var(--accent-soft)]"
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
    </div>
  );
}
