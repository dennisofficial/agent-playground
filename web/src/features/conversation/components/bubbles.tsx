'use client';

import { ExternalLink, Lock } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { SystemTone } from '@/features/conversation/classify';
import type { WebOutboundMessage } from '@/lib/api/types';

/** Small Atlas/Claude avatar — the brand mark, mini. */
export function ClaudeAvatar() {
  return (
    <span
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px]"
      style={{ background: 'linear-gradient(145deg, var(--accent), var(--accent-2))' }}
      aria-hidden
    >
      <span
        style={{
          width: 9,
          height: 9,
          transform: 'rotate(45deg)',
          border: '1.4px solid rgba(255,255,255,0.92)',
          borderRadius: 1.5,
        }}
      />
    </span>
  );
}

export function UserBubble({ message }: { message: WebOutboundMessage }) {
  return (
    <div className="anim-fadeUp flex justify-end">
      <div
        className="max-w-[78%] whitespace-pre-wrap rounded-lg rounded-tr-sm px-3.5 py-2.5 text-[13.5px] text-text"
        style={{ background: 'var(--accent-soft)', border: '1px solid var(--accent-line)' }}
      >
        {message.text}
      </div>
    </div>
  );
}

export function ClaudeBubble({ message }: { message: WebOutboundMessage }) {
  return (
    <div className="anim-fadeUp flex gap-2.5">
      <ClaudeAvatar />
      <div className="max-w-[82%] whitespace-pre-wrap rounded-lg rounded-tl-sm border border-border bg-surface-2 px-3.5 py-2.5 text-[13.5px] text-text">
        {message.text}
      </div>
    </div>
  );
}

export function DecisionChip({ message }: { message: WebOutboundMessage }) {
  return (
    <div className="anim-fadeUp mx-auto flex max-w-[88%] items-start gap-2 rounded-md border border-border bg-surface-2 px-3 py-2">
      <Lock size={13} className="mt-0.5 shrink-0 text-faint" />
      <p className="whitespace-pre-wrap text-[12.5px] text-dim">{message.text}</p>
    </div>
  );
}

const TONE_COLOR: Record<SystemTone, string> = {
  ok: 'var(--green)',
  warn: 'var(--red)',
  accent: 'var(--accent)',
  neutral: 'var(--faint)',
};

export function SystemEventPill({ message, tone }: { message: WebOutboundMessage; tone: SystemTone }) {
  return (
    <div className="anim-fadeUp flex justify-center">
      <span className="inline-flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1 text-[11.5px] text-dim">
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: TONE_COLOR[tone] }} />
        <span className="max-w-[520px] truncate font-mono text-[10.5px]">{message.text}</span>
      </span>
    </div>
  );
}

export function ParkAndAsk({ message }: { message: WebOutboundMessage }) {
  return (
    <div
      className="anim-pop rounded-lg border px-4 py-3.5"
      style={{
        background: 'color-mix(in srgb, var(--red) 6%, transparent)',
        borderColor: 'color-mix(in srgb, var(--red) 40%, transparent)',
      }}
    >
      <div className="flex items-center gap-2">
        <span className="pulse-dot h-2 w-2 rounded-full" style={{ background: 'var(--red)' }} />
        <span className="text-[12px] font-semibold" style={{ color: 'var(--red)' }}>
          Decision needed — paused
        </span>
      </div>
      <p className="mt-2 whitespace-pre-wrap text-[13px] text-text">{message.text}</p>
      <p className="mt-2 text-[11.5px] text-dim">Reply below to answer.</p>
    </div>
  );
}

const PR_URL_RE = /https?:\/\/github\.com\/\S+\/pull\/\d+/i;

export function PrCard({ message }: { message: WebOutboundMessage }) {
  const url = message.text.match(PR_URL_RE)?.[0];
  return (
    <div className="anim-pop rounded-lg border border-border bg-surface p-4" style={{ boxShadow: 'var(--shadow-card)' }}>
      <div className="flex items-center gap-2">
        <span className="font-mono text-[9px] uppercase tracking-[0.14em]" style={{ color: 'var(--green)' }}>
          Pull request
        </span>
      </div>
      <p className="mt-1.5 whitespace-pre-wrap text-[13px] text-text">{message.text}</p>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          disabled
          className="rounded-md border border-border px-3 py-1.5 text-[12px] text-faint"
          title="Needs a backend resume/ready route (BACKEND_GAPS.md)"
        >
          Mark ready for review
        </button>
        {url ? (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-medium text-white"
            style={{ background: 'linear-gradient(145deg, var(--accent), var(--accent-2))' }}
          >
            Open on GitHub <ExternalLink size={12} />
          </a>
        ) : null}
      </div>
    </div>
  );
}

export function LiveIndicator() {
  return (
    <div className="flex items-center gap-2 text-[11px] text-faint">
      <span className="pulse-dot h-1.5 w-1.5 rounded-full" style={{ background: 'var(--accent)' }} />
      <span>Atlas is working…</span>
    </div>
  );
}
