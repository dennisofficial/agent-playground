'use client';

import { useState } from 'react';
import { ChevronRight, Clock } from 'lucide-react';
import type { SystemTone } from './classify';
import { Markdown } from './markdown';
import { ToolGroup, segmentToolRun, type ToolItem } from './tool-calls';
import type { ThreadMessage } from '@/lib/api/thread-api';
import type { LiveBlock, LiveTurn } from '@/lib/api/thread-stream';

/** Small Atlas/Claude avatar — the brand mark, mini (the rotated rounded square). */
export function ClaudeAvatar({ size = 24 }: { size?: number }) {
  const inner = Math.round(size * 0.38);
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-md"
      style={{ width: size, height: size, background: 'linear-gradient(145deg, var(--accent), var(--accent-2))' }}
      aria-hidden
    >
      <span
        style={{
          width: inner,
          height: inner,
          transform: 'rotate(45deg)',
          border: '1.5px solid rgba(255,255,255,0.92)',
          borderRadius: 2,
        }}
      />
    </span>
  );
}

export function UserBubble({ message, queued = false }: { message: ThreadMessage; queued?: boolean }) {
  return (
    <div className="anim-fadeUp flex flex-col items-end gap-1">
      <div
        className="max-w-[72%] whitespace-pre-wrap px-[13px] py-2 text-[13.5px] leading-relaxed text-text"
        style={{
          background: 'var(--accent-soft)',
          border: '1px solid var(--accent-line)',
          borderRadius: '13px 13px 4px 13px',
          opacity: queued ? 0.72 : 1,
        }}
      >
        {message.text}
      </div>
      {queued ? (
        <span className="flex items-center gap-1 pr-0.5 font-mono text-[9.5px] uppercase tracking-[0.1em] text-faint">
          <Clock size={10} className="shrink-0" />
          queued · sends when the current turn finishes
        </span>
      ) : null}
    </div>
  );
}

export function ClaudeBubble({ message }: { message: ThreadMessage }) {
  return <StreamTextBubble text={message.text} />;
}

/**
 * An assistant message — rendered as markdown prose (no avatar, no bubble), per the conversation redesign.
 * `streaming` adds a blinking cursor for the live (token-by-token) turn.
 */
export function StreamTextBubble({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return (
    <div className="anim-fadeUp">
      <Markdown>{text}</Markdown>
      {streaming ? (
        <span
          className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[2px] animate-pulse"
          style={{ background: 'var(--accent)' }}
          aria-hidden
        />
      ) : null}
    </div>
  );
}

/** A collapsible thinking block (the model's reasoning) — dimmed + italic, like Claude Code. */
export function ThinkingBlock({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="anim-fadeUp">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 text-left font-mono text-[11px] italic text-faint hover:text-dim"
      >
        <ChevronRight size={11} strokeWidth={2.6} className={`shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
        {streaming ? 'thinking…' : 'thought'}
      </button>
      {open ? (
        <p
          className="mt-1.5 whitespace-pre-wrap pl-[18px] text-[12.5px] italic leading-relaxed text-dim"
          style={{ borderLeft: '2px solid var(--border)' }}
        >
          {text}
        </p>
      ) : null}
    </div>
  );
}

/** Render a thread's in-flight LIVE turn (token-streamed text, thinking, and grouped tool calls). */
export function LiveTurnView({ turn }: { turn: LiveTurn }) {
  // Collapse runs of consecutive tool blocks into one group; text/thinking break the run.
  const items: Array<{ key: string; node: React.ReactNode }> = [];
  let pending: ToolItem[] = [];
  const flush = () => {
    if (pending.length === 0) return;
    for (const seg of segmentToolRun(pending)) {
      items.push({ key: `tg-${seg[0].key}`, node: <ToolGroup tools={seg} /> });
    }
    pending = [];
  };

  for (const b of turn.blocks as LiveBlock[]) {
    if (b.kind === 'tool') {
      pending.push({ key: b.key, name: b.name, input: b.input, result: b.result, isError: b.isError, running: !b.done });
      continue;
    }
    flush();
    if (b.kind === 'text') {
      items.push({ key: b.key, node: <StreamTextBubble text={b.text} streaming={!b.done && turn.active} /> });
    } else {
      items.push({ key: b.key, node: <ThinkingBlock text={b.text} streaming={!b.done && turn.active} /> });
    }
  }
  flush();

  return (
    <>
      {items.map((it) => (
        <div key={it.key}>{it.node}</div>
      ))}
    </>
  );
}

const TONE_COLOR: Record<SystemTone, string> = {
  ok: 'var(--green)',
  warn: 'var(--red)',
  accent: 'var(--accent)',
  neutral: 'var(--faint)',
};

export function SystemEventPill({ message, tone }: { message: ThreadMessage; tone: SystemTone }) {
  return (
    <div
      className="anim-fadeUp flex items-center gap-2.5 self-stretch rounded-md border px-3.5 py-1.5 font-mono text-[10px] text-dim"
      style={{ borderColor: 'var(--hair)', background: 'color-mix(in srgb, var(--surface-2) 70%, transparent)' }}
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: TONE_COLOR[tone] }} />
      <span className="truncate">{message.text}</span>
    </div>
  );
}

export function LiveIndicator({ text = 'Atlas is working…' }: { text?: string }) {
  return (
    <div className="anim-fadeUp flex items-center gap-2.5 text-[11.5px] text-accent">
      <span className="pulse-dot h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: 'var(--accent)', boxShadow: '0 0 9px var(--accent)' }} />
      <span>{text}</span>
    </div>
  );
}
