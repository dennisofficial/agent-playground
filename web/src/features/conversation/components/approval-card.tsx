'use client';

import Link from 'next/link';
import { CheckCircle2, FileText } from 'lucide-react';
import { ROUTES } from '@/lib/routes';
import { APPROVE_ACTION_ID, type WebApprovalCard, type WebVerdictCard } from '@/lib/api/types';
import { VerdictButtons } from '@/components/approval/verdict-buttons';

/**
 * Plan/approval card. Approve / Request changes / Deny POST `/web/approve` with the action's verbatim
 * `value`. After a verdict the backend re-emits the card as a verdict_card with the SAME ts, so the
 * SSE merge repaints this in place. `note` is intentionally absent — the backend drops it
 * (BACKEND_GAPS.md #5); reasoning goes in the composer.
 */
export function ApprovalCardView({
  card,
  threadKey,
}: {
  card: WebApprovalCard;
  threadKey: string;
}) {
  const value = card.actions.find((a) => a.actionId === APPROVE_ACTION_ID)?.value ?? '';

  return (
    <div
      className="anim-pop rounded-lg border border-border bg-surface p-4"
      style={{ boxShadow: 'var(--shadow-card)' }}
    >
      <div className="flex items-center gap-2">
        <span
          className="rounded-sm px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-[0.14em]"
          style={{ color: 'var(--purple)', background: 'color-mix(in srgb, var(--purple) 12%, transparent)' }}
        >
          Plan · for review
        </span>
      </div>

      <h3 className="mt-2.5 text-[15px] font-semibold text-text">{card.title}</h3>
      {card.summary ? (
        <p className="mt-1.5 whitespace-pre-wrap text-[12.5px] text-dim">{card.summary}</p>
      ) : null}

      <p className="mt-3 font-mono text-[10.5px] text-faint">
        {card.decisions.length} locked decision{card.decisions.length === 1 ? '' : 's'} ·{' '}
        {card.sections.length} section{card.sections.length === 1 ? '' : 's'}
      </p>

      <Link
        href={ROUTES.threadPlan(threadKey)}
        className="mt-3 inline-flex items-center gap-1.5 text-[12.5px] font-medium text-accent hover:underline"
      >
        <FileText size={13} /> Open full plan
      </Link>

      <div className="mt-4">
        <VerdictButtons value={value} />
      </div>
    </div>
  );
}

/** Green confirmation bar that replaces the approval card after a ruling. */
export function VerdictCardView({ card }: { card: WebVerdictCard }) {
  const approved = card.verdict === 'approve';
  const color = approved ? 'var(--green)' : 'var(--red)';
  return (
    <div
      className="anim-pop flex items-center gap-2.5 rounded-lg border px-4 py-3"
      style={{
        background: `color-mix(in srgb, ${color} 8%, transparent)`,
        borderColor: `color-mix(in srgb, ${color} 35%, transparent)`,
      }}
    >
      <CheckCircle2 size={16} style={{ color }} />
      <div>
        <p className="text-[12.5px] font-semibold" style={{ color }}>
          {card.title}
        </p>
        <p className="text-[12px] text-dim">{card.verdictLine}</p>
      </div>
    </div>
  );
}
