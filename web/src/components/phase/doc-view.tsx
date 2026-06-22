'use client';

import { Lock } from 'lucide-react';
import { useThreadMessages } from '@/lib/api/queries';
import type { WebApprovalCard } from '@/lib/api/types';
import { DocFrame, EmptyDoc } from './doc-frame';
import { FullPlan } from './full-plan';

/**
 * Doc view (`§N · plan.md`, `decision-record.md`). `decision-record` renders the locked decisions from
 * the latest approval card; `plan` defers to the full plan; anything else is a titled placeholder.
 */
export function DocView({
  channel,
  threadTs,
  docId,
}: {
  channel: string;
  threadTs: string;
  docId: string;
}) {
  const { messages } = useThreadMessages(channel, threadTs);

  if (docId === 'plan') return <FullPlan channel={channel} threadTs={threadTs} />;

  if (docId === 'decision-record') {
    const approval = [...messages].reverse().find((m) => m.card?.type === 'approval_card');
    const card = approval?.card?.type === 'approval_card' ? (approval.card as WebApprovalCard) : undefined;
    if (!card || card.decisions.length === 0) {
      return (
        <EmptyDoc
          title="decision-record.md"
          body="No locked decisions yet. Decisions are recorded when Atlas proposes a plan."
        />
      );
    }
    return (
      <DocFrame>
        <div className="flex items-center gap-2">
          <Lock size={13} className="text-faint" />
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-faint">decision-record.md</p>
        </div>
        <h1 className="mt-2 font-disp text-[22px] font-semibold text-text">{card.title}</h1>
        <div className="mt-5 flex flex-col gap-3">
          {card.decisions.map((d, i) => (
            <div key={i} className="rounded-md border border-border bg-surface-2 px-4 py-3">
              <span
                className="rounded-sm px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider"
                style={{ color: 'var(--purple)', background: 'color-mix(in srgb, var(--purple) 12%, transparent)' }}
              >
                {d.decisionClass}
              </span>
              <h3 className="mt-2 text-[14px] font-semibold text-text">{d.title}</h3>
              <p className="mt-1 text-[13px] text-dim">{d.ruling}</p>
            </div>
          ))}
        </div>
      </DocFrame>
    );
  }

  return <EmptyDoc title={`${docId}`} body="This document isn't available over the web surface yet." />;
}
