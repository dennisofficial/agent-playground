'use client';

import { ChevronRight, Hammer, MessageSquareText } from 'lucide-react';
import { useState } from 'react';
import { Markdown } from './markdown';

/**
 * The live-stream lane a build THREAD streams on — STABLE per thread (like the brain's `main`), so the web
 * subscribes by thread identity. A thread's durable transcript is filtered by the message's own `threadId`
 * field, so this lane string is used only for the live turn subscription.
 */
export const threadLane = (threadId: string): string => `thread:${threadId}`;

/**
 * The opening "what was asked" block on a build THREAD/STEP lane — the instruction the engine received
 * (goal + locked decisions + per-step briefs). It's a long generated markdown DOCUMENT, not an operator
 * chat line, so it renders as a full-width, collapsible panel with a real markdown body — NOT a right-
 * aligned prose bubble, which showed the raw `###`/`**` source and read as a chat message the operator
 * never typed. Default-open so each lane still opens with "what was asked"; collapse to get out of the way.
 */
export function BuildInstruction({ text }: { text: string }) {
  const [open, setOpen] = useState(true);
  return (
    <div
      className="anim-fadeUp rounded-[9px] border"
      style={{
        borderColor: 'var(--border-2)',
        background: 'color-mix(in srgb, var(--surface-2) 60%, transparent)',
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 rounded-t-[8px] px-3.5 py-2 text-left"
        style={{
          borderBottom: open ? '1px solid var(--border)' : 'none',
          background: 'color-mix(in srgb, var(--surface-3) 70%, transparent)',
        }}
      >
        <ChevronRight
          size={11}
          strokeWidth={2.6}
          className={`shrink-0 text-faint transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <Hammer size={12} className="shrink-0 text-dim" />
        <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-dim">
          Build instruction
        </span>
        <span className="truncate font-mono text-[10px] text-faint">
          what this thread was asked to do
        </span>
      </button>
      {open ? (
        <div className="px-3.5 py-3">
          <Markdown>{text}</Markdown>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The `agent_prompt` block — THIS turn's initial task (its "first message"), the exact prompt the engine
 * received. Rendered inline at the top of every agent lane (Codex review, the verification gate, autofix,
 * the brain's main turn) so prompt iteration isn't blind. Collapsible; `defaultOpen` is true on the agent
 * sub-lanes (the prompt is the whole point there) and false on Main (the operator's own message bubble
 * already shows the gist — the disclosure reveals the invisible folded context on demand).
 */
export function AgentPromptBlock({
  text,
  defaultOpen = true,
}: {
  text: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div
      className="anim-fadeUp rounded-[9px] border"
      style={{
        borderColor: 'var(--border-2)',
        background: 'color-mix(in srgb, var(--surface-2) 60%, transparent)',
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 rounded-t-[8px] px-3.5 py-2 text-left"
        style={{
          borderBottom: open ? '1px solid var(--border)' : 'none',
          background: 'color-mix(in srgb, var(--surface-3) 70%, transparent)',
        }}
      >
        <ChevronRight
          size={11}
          strokeWidth={2.6}
          className={`shrink-0 text-faint transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <MessageSquareText size={12} className="shrink-0 text-dim" />
        <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-dim">
          Prompt
        </span>
        <span className="truncate font-mono text-[10px] text-faint">what the agent was asked</span>
      </button>
      {open ? (
        <div className="px-3.5 py-3">
          <Markdown>{text}</Markdown>
        </div>
      ) : null}
    </div>
  );
}
