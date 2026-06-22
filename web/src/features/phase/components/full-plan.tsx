'use client';

import { PlanMarkdown } from '@/features/phase/components/markdown';
import { VerdictButtons } from '@/components/approval/verdict-buttons';
import { useThreadMessages } from '@/lib/api/messages';
import { APPROVE_ACTION_ID, type WebApprovalCard } from '@/lib/api/types';
import { DocFrame, EmptyDoc } from './doc-frame';

/**
 * Full plan page (`plan.md`). Built from the thread's latest approval card — title, overview, LOCKED
 * DECISIONS, SECTIONS — plus the verdict buttons when still gated. Reuses `PlanMarkdown` for the
 * overview (mermaid-aware).
 */
export function FullPlan({ channel, threadTs }: { channel: string; threadTs: string }) {
  const { messages } = useThreadMessages(channel, threadTs);
  const approval = [...messages].reverse().find((m) => m.card?.type === 'approval_card');
  const card = approval?.card?.type === 'approval_card' ? (approval.card as WebApprovalCard) : undefined;
  const gated = !!card && !messages.some((m) => m.card?.type === 'verdict_card');

  if (!card) {
    return (
      <EmptyDoc
        title="plan.md"
        body="No plan has been proposed yet. Atlas drafts the plan in the conversation, then posts it here for approval."
      />
    );
  }

  const value = card.actions.find((a) => a.actionId === APPROVE_ACTION_ID)?.value ?? '';

  return (
    <DocFrame>
      <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-faint">plan.md</p>
      <h1 className="mt-2 font-disp text-[22px] font-semibold text-text">{card.title}</h1>

      {card.summary ? (
        <div className="mt-4">
          <PlanMarkdown markdown={card.summary} />
        </div>
      ) : null}

      {card.decisions.length > 0 ? (
        <section className="mt-7">
          <h2 className="font-mono text-[10px] uppercase tracking-[0.16em] text-faint">Locked decisions</h2>
          <div className="mt-2 flex flex-col gap-2">
            {card.decisions.map((d, i) => (
              <div key={i} className="rounded-md border border-border bg-surface-2 px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <span
                    className="rounded-sm px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider"
                    style={{ color: 'var(--purple)', background: 'color-mix(in srgb, var(--purple) 12%, transparent)' }}
                  >
                    {d.decisionClass}
                  </span>
                  <span className="text-[12.5px] font-semibold text-text">{d.title}</span>
                </div>
                <p className="mt-1.5 text-[12.5px] text-dim">{d.ruling}</p>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="mt-7">
        <h2 className="font-mono text-[10px] uppercase tracking-[0.16em] text-faint">Sections</h2>
        <ol className="mt-2 flex flex-col gap-1.5">
          {card.sections.map((s, i) => (
            <li key={i} className="flex gap-2.5 text-[13px] text-text">
              <span className="font-mono text-[11px] text-faint">§{i + 1}</span>
              <span>{s}</span>
            </li>
          ))}
        </ol>
      </section>

      {gated ? (
        <div className="mt-8 border-t border-border pt-5">
          <VerdictButtons value={value} approveLabel="Approve & build" size="md" />
        </div>
      ) : null}
    </DocFrame>
  );
}
