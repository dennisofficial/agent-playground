"use client";

import Link from "next/link";
import { ArrowRight, TicketIcon } from "lucide-react";
import { ROUTES } from "@/lib/routes";
import type { JobRef } from "@/lib/api/job-api";
import type { WebTicketCard } from "@/lib/api/types";

/** Priority → accent, so "urgent"/"high" reads at a glance; the rest stay dim. */
function priorityColor(priority: string | null): string | undefined {
  if (priority === "urgent") return "var(--red)";
  if (priority === "high") return "var(--amber)";
  return undefined;
}

/**
 * Atlas raised a ticket mid-job via `create_ticket` — a live callout on the conversation so out-of-scope
 * work the brain parked is SEEN by the operator, not buried in the transcript. Purely informational: it
 * links through to the ticket on the repo's board (opening that ticket's drawer via `?ticket=<id>`). The
 * ticket itself lives on the board; this is just the relay.
 */
export function TicketCardView({
  card,
  jobRef,
}: {
  card: WebTicketCard;
  jobRef: JobRef;
}) {
  const badges = [card.kind, card.priority, card.status].filter(
    (b): b is string => !!b,
  );
  const href = `${ROUTES.tickets(jobRef.orgId, jobRef.repoId)}?ticket=${card.ticketId}`;

  return (
    <div className="anim-pop self-stretch overflow-hidden rounded-lg border border-border bg-surface">
      <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
        <TicketIcon size={15} className="text-accent" />
        <span className="text-[13px] font-semibold text-text">
          Atlas raised a ticket
        </span>
      </div>

      <div className="flex flex-col gap-2 px-4 py-3">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-[12.5px] font-semibold text-dim">
            #{card.number}
          </span>
          <span className="min-w-0 text-[13px] font-medium text-text">
            {card.title}
          </span>
        </div>

        {badges.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {badges.map((b) => (
              <span
                key={b}
                className="rounded-full border border-border px-1.5 py-0.5 text-[9.5px] uppercase text-dim"
                style={
                  b === card.priority
                    ? { color: priorityColor(card.priority) }
                    : undefined
                }
              >
                {b}
              </span>
            ))}
          </div>
        ) : null}

        {card.originDecisionSummary ? (
          <p className="text-[12px] leading-snug text-dim">
            Diverged from: {card.originDecisionSummary}
          </p>
        ) : null}
      </div>

      <div className="border-t border-border bg-surface-2 px-4 py-2.5">
        <Link
          href={href}
          className="inline-flex items-center gap-1 text-[12px] font-medium text-accent hover:underline"
        >
          View ticket
          <ArrowRight size={13} />
        </Link>
      </div>
    </div>
  );
}
