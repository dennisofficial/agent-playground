'use client';

import { ExternalLink, Lock, MessageSquare } from 'lucide-react';
import type { SystemTone } from './classify';
import type { ThreadMessage } from '@/lib/api/thread-api';

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

export function UserBubble({ message }: { message: ThreadMessage }) {
  return (
    <div className="anim-fadeUp flex justify-end">
      <div
        className="max-w-[74%] whitespace-pre-wrap rounded-[13px] rounded-tr-sm px-3.5 py-2.5 text-[13px] leading-relaxed text-text"
        style={{ background: 'var(--accent-soft)', border: '1px solid var(--accent-line)' }}
      >
        {message.text}
      </div>
    </div>
  );
}

export function ClaudeBubble({ message }: { message: ThreadMessage }) {
  return (
    <div className="anim-fadeUp flex gap-2.5">
      <ClaudeAvatar />
      <div className="max-w-[86%] whitespace-pre-wrap rounded-[13px] rounded-tl-sm border border-border bg-surface-2 px-3.5 py-2.5 text-[13px] leading-relaxed text-text">
        {message.text}
      </div>
    </div>
  );
}

export function DecisionChip({ message }: { message: ThreadMessage }) {
  return (
    <div className="anim-fadeUp flex max-w-[86%] items-start gap-2.5 rounded-md border border-border bg-surface-2 px-3 py-2.5">
      <Lock size={14} className="mt-0.5 shrink-0 text-dim" />
      <p className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-text">{message.text}</p>
    </div>
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
    <div className="anim-fadeUp flex justify-center">
      <span
        className="inline-flex items-center gap-2 rounded-full border px-3.5 py-1 font-mono text-[10px] text-dim"
        style={{ borderColor: 'var(--hair)', background: 'color-mix(in srgb, var(--surface-2) 70%, transparent)' }}
      >
        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: TONE_COLOR[tone] }} />
        <span className="max-w-[560px] truncate">{message.text}</span>
      </span>
    </div>
  );
}

export function ParkAndAsk({ message }: { message: ThreadMessage }) {
  return (
    <div
      className="anim-pop self-stretch rounded-lg border px-4 py-3.5"
      style={{
        background: 'color-mix(in srgb, var(--red) 6%, transparent)',
        borderColor: 'color-mix(in srgb, var(--red) 40%, transparent)',
      }}
    >
      <div className="flex items-center gap-2">
        <span className="pulse-dot h-2 w-2 rounded-full" style={{ background: 'var(--red)' }} />
        <span className="text-[12.5px] font-semibold" style={{ color: 'var(--red)' }}>
          Decision needed — paused
        </span>
      </div>
      <p className="mt-2 whitespace-pre-wrap text-[12.5px] leading-relaxed text-text">{message.text}</p>
      <p className="mt-2 flex items-center gap-1.5 font-mono text-[10px] text-faint">
        <MessageSquare size={12} /> reply below to answer — the build resumes on your reply
      </p>
    </div>
  );
}

const PR_URL_RE = /https?:\/\/github\.com\/\S+\/pull\/\d+/i;

export function PrCard({ message }: { message: ThreadMessage }) {
  const url = message.text.match(PR_URL_RE)?.[0];
  return (
    <div className="anim-pop self-stretch rounded-lg border border-border bg-surface p-4" style={{ boxShadow: 'var(--shadow-card)' }}>
      <span className="font-mono text-[9px] uppercase tracking-[0.14em]" style={{ color: 'var(--green)' }}>
        Pull request
      </span>
      <p className="mt-1.5 whitespace-pre-wrap text-[13px] text-text">{message.text}</p>
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="mt-3 inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-medium text-white"
          style={{ background: 'linear-gradient(145deg, var(--accent), var(--accent-2))' }}
        >
          Open on GitHub <ExternalLink size={12} />
        </a>
      ) : null}
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
